# Change tracker, working off a koIDocument.

import time
import logging
import threading
from itertools import chain

from xpcom import components, nsError, ServerException, COMException
from xpcom.server import WrapObject, UnwrapObject
from xpcom.client import WeakReference

import difflibex

#-- Globals variables

log = logging.getLogger('koChangeTracker')
#log.setLevel(logging.DEBUG)

#-- Internal functions

class DiffOpCode(object):
    def __init__(self, tag, i1, i2, j1, j2):
        self.tag = tag
        self.i1 = i1
        self.i2 = i2
        self.j1 = j1
        self.j2 = j2

################################################################################
#                           Track Changes
################################################################################

class DocumentChangeTracker(object):
    koIChangeTracker = components.interfaces.koIChangeTracker

    _com_interfaces_ = [koIChangeTracker]
    _reg_desc_ = "Document Change Tracker"
    _reg_contractid_ = "@activestate.com/koChangeTracker;1"
    _reg_clsid_ = "{7b258fa9-dd80-4c28-bcaf-c203be779278}"

    CHANGES_NONE    = koIChangeTracker.CHANGES_NONE
    CHANGES_INSERT  = koIChangeTracker.CHANGES_INSERT
    CHANGES_DELETE  = koIChangeTracker.CHANGES_DELETE
    CHANGES_REPLACE = koIChangeTracker.CHANGES_REPLACE

    REQUEST_TIMEOUT_PERIOD = 60.0 # seconds

    # Thread thread handle for fetching on-disk changes asyncronously.
    _ondisk_thread = None
    # When the ondisk thread was started.
    _ondisk_thread_timestamp = None
    # The scc cat koIAsyncOperation - fetching the scc file contents.
    _scc_cat_request = None
    # When the scc cat request was requested.
    _scc_request_timestamp = None
    # Whether the existing _scc_cat_request is out of date and needs to be re-run.
    _scc_request_out_of_date = False
    # Remember the contents - for show changes in a dialog.
    _reference_lines = None

    def init(self, koDoc):
        if koDoc is not None:
            self._koDoc = WeakReference(koDoc)
        else:
            self._koDoc = None

        self.clearTrackingData()

    def finalize(self):
        self.clearPendingSccRequest()
        self._koDoc = None

    def clearTrackingData(self):
        self.first_interesting_line = {}  # Map lineNo => first line (for insert & change)
        self.last_insertions = {}        # Map firstLine => [lastLine]
        self.last_modifications = {}        # Map firstLine => [lastLine]
        self.deleted_text_line_range = {}  # Map firstLine(new) => [firstLine(old), lastLine(old)]
        self.changed_text_line_range = {}  # Like deletedTextLines:  new(first) => old range
        self.inserted_old_line_range = {}  # Map firstLine => oldLineRange (insert only)

    def clearPendingSccRequest(self):
        if self._scc_cat_request:
            try:
                self._scc_cat_request.stop()
            except:
                log.warn("Unable to stop scc cat request for %r",
                         self.koDoc.displayPath)
            self._scc_cat_request = None

    @property
    def koDoc(self):
        doc = None
        if self._koDoc:
            try:
                doc = self._koDoc()
            except:
                pass  # dead object
        if doc is None:
            raise ServerException(nsError.NS_ERROR_FAILURE, "koDoc reference has expired")
        if not "isCollab" in dir(doc) or not doc.isCollab():
            return UnwrapObject(doc)
        else:
            return doc # for some reason, collab docs are already unwrapped

    @components.ProxyToMainThread
    def notifyError(self, handler, message):
        handler.onError(message)

    @components.ProxyToMainThread
    def notifyChanges(self, handler, changes):
        try:
            self.clearTrackingData()
            last_insertions = self.last_insertions
            last_modifications = self.last_modifications
            deleted_text_line_range = self.deleted_text_line_range

            lim = len(changes)
            try:
                view = self.koDoc.getView()
            except ServerException:
                view = False
            if not view:
                log.warn("View no longer exists, exiting")
                return
            
            lineCount = view.scimoz.lineCount
            for change in changes:
                tag = change.tag
                i1 = change.i1
                i2 = change.i2
                j1 = change.j1
                j2 = change.j2
                if tag == 'equal':
                    pass
                elif tag == 'replace':
                    last_modifications[j1] = j2
                    self.changed_text_line_range[j1] = [i1, i2]
                    for idx in range(j2 - j1):
                        self.first_interesting_line[j1 + idx] = j1
                elif tag == 'delete':
                    if j1 == lineCount:
                        j1 -= 1
                    deleted_text_line_range[j1] = [i1, i2]
                elif tag == 'insert':
                    last_insertions[j1] = j2
                    for idx in range(j2 - j1):
                        self.first_interesting_line[j1 + idx] = j1
                    self.inserted_old_line_range[j1] = [i1, i2]
                else:
                    log.error("Unexpected diff opcode tag: %s", tag);

            # Send changes to handler.
            if "isCollab" in dir(self.koDoc) and self.koDoc.isCollab():
                name = 'collab'
            else:
                name = self.koDoc.file.leafName
            deleted_lines = deleted_text_line_range.keys()
            inserted_lines = list(chain(*(last_insertions.items())))
            modified_lines = list(chain(*(last_modifications.items())))
            log.debug("changes for %r\n"
                      "  deleted_lines: %r\n"
                      "  inserted_lines: %r\n"
                      "  modified_lines: %r",
                      name, deleted_lines, inserted_lines, modified_lines)
            try:
                handler.markChanges(deleted_lines, inserted_lines, modified_lines)
            except Exception as innex:
                # Callback gave an error - log it.
                log.error("notifyChanges:: markChanges handler had an error %r", innex)
            # All done.
        except Exception as ex:
            log.exception("notifyChanges:: exception")
            handler.onError(str(ex))

    def _generateDiffOpcodes(self, left_lines, right_lines):
        """
        The output consists of a list of tuples:
        [instruction, oldStart, oldEnd, newStart, newEnd].  See
        difflib.py::SequenceManager.get_opcodes for more documentation.
        """
        opCode = DiffOpCode
        return [opCode(*diff) for diff in
                difflibex.SequenceMatcher(a=left_lines, b=right_lines).get_opcodes()]

    def _notifyFileChanges(self, handler, ondisk_lines):
        keepEOLs = False
        if ondisk_lines and ondisk_lines[0] and ondisk_lines[0][-1] in "\r\n":
            keepEOLs = True
        inmemory_lines = self.koDoc.buffer.splitlines(keepEOLs)
        changes = self._generateDiffOpcodes(ondisk_lines, inmemory_lines)
        self.notifyChanges(handler, changes)
        self._reference_lines = ondisk_lines

    def _threadOnDiskFileChanges(self, handler):
        # Mark the thread as done - so other requests can be run later.
        self._ondisk_thread = None
        # Notify changes
        ondisk_lines = self.koDoc.ondisk_lines
        self._notifyFileChanges(handler, ondisk_lines)

    def getDiskChangesAsync(self, handler, koDoc, koFile):
        # Yucky Pyxpcom unwrapped method call.
        if not koDoc.get_isDirty():
            # Not modified.
            log.debug("getDiskChangesAsync:: document is not dirty - no changes")
            self.notifyChanges(handler, [])
            return

        if self._ondisk_thread:
            # An existing thread is already running.
            elapsed_time = time.time() - self._ondisk_thread_timestamp
            if elapsed_time >= self.REQUEST_TIMEOUT_PERIOD:
                self._ondisk_thread = None
                log.info("getDiskChangesAsync:: pending request has expired")
                self.notifyError(handler, "Could not get on-disk file contents in %d "
                                          "seconds" % (self.REQUEST_TIMEOUT_PERIOD, ))
            return
        log.debug("getDiskChangesAsync:: creating thread for on-disk changes")
        self._ondisk_thread = threading.Thread(name="koChangeTracker async on-disk changes",
                                        target=self._threadOnDiskFileChanges,
                                        args=(handler,),
                                       )
        self._ondisk_thread.setDaemon(True)
        self._ondisk_thread_timestamp = time.time()
        self._ondisk_thread.start()

    def _sccCatCallback(self, result_code, message):
        if not self._scc_cat_request:
            # Already handled.
            log.info("_sccCatCallback:: request previously handled!?")
            return
        handler = self._scc_cat_request.data
        try:
            handler.QueryInterface(components.interfaces.koIChangeTrackerHandler)
        except COMException:
            log.warn("handler is not a valid koIChangeTrackerHandler object")
            return

        if result_code:
            log.info("_sccCatCallback:: bad result %d, %s", result_code, message)
            self.notifyError(handler, "Scc error %s" % (str(message), ))
            return
        log.debug("_sccCatCallback:: successful got scc file contents")
        # Reset working variables
        scc_lines = message.splitlines()
        self._scc_cat_request.data = None
        self._scc_cat_request = None
        self._scc_request_timestamp = None
        self._notifyFileChanges(handler, scc_lines)
        if self._scc_request_out_of_date:
            # Generate a new request - after a slight pause.
            log.info("_sccCatCallback:: generating new scc request, as "
                     "existing one is already out-of-date")
            time.sleep(0.5)
            self.getSccChangesAsync(handler)

    def getSccChangesAsync(self, handler):
        # Check if there is already a pending SCC file request.
        if self._scc_cat_request:
            log.debug("getSccChangesAsync:: has a pending request already")
            self._scc_request_out_of_date = True
            elapsed_time = time.time() - self._scc_request_timestamp
            if elapsed_time >= self.REQUEST_TIMEOUT_PERIOD:
                log.info("getSccChangesAsync:: pending request has expired")
                self.clearPendingSccRequest()
                self.notifyError(handler, "Could not get scc file contents in %d "
                                          "seconds" % (self.REQUEST_TIMEOUT_PERIOD, ))
            return
        koFile = self.koDoc.file
        if not koFile:
            self.notifyError(handler, "koDoc does have a valid file %r" % (self.koDoc.displayPath,))
            return
        scc_type = koFile.sccType
        if not scc_type:
            self.notifyError(handler, "koDoc file no longer under SCC %r" % (self.koDoc.displayPath,))
            return
        # Make a SCC file request.
        log.debug("getSccChangesAsync:: requesting scc changes")
        cid = "@activestate.com/koSCC?type=%s;1" % (scc_type,)
        sccSvc = components.classes[cid].getService(components.interfaces.koISCC)
        urls = [koFile.URI]
        self._scc_request_out_of_date = False
        self._scc_request_timestamp = time.time()
        self._scc_cat_request = sccSvc.cat(koFile.baseName, koFile.dirName, '', self._sccCatCallback)
        # Remember the handler for the request.
        self._scc_cat_request.data = handler

    def collabStoreState(self):
        """
        Mark the existing buffer contents as 'saved' for collaborative
        documents. Changes from this current state will now be tracked.
        """
        if "isCollab" in dir(self.koDoc) and self.koDoc.isCollab():
            self._reference_lines = self.koDoc.buffer.splitlines(True)
            log.debug("Stored collab state: %r", self._reference_lines)

    def updateChangeTracker(self, handler):
        koDoc = self.koDoc
        koFile = koDoc.file
        if koFile is not None:
            # Asynchronously fetch and update the file changes.
            try:
                if hasattr(koFile, "sccType") and koFile.sccType:
                    self.getSccChangesAsync(handler)
                else:
                    self.getDiskChangesAsync(handler, koDoc, koFile)
            except Exception as ex:
                log.exception("Exception while trying retrieve changes", ex) 
        elif "isCollab" in dir(self.koDoc) and self.koDoc.isCollab():
            log.info("updateChangeTracker:: collab file")
            self._notifyFileChanges(handler, self._reference_lines or [])
        else:
            log.info("updateChangeTracker:: no file and no collab - abort")

    @components.ProxyToMainThread
    def getOldAndNewLines(self, lineno, change_type):
        if not lineno and hasattr(self, "lastLineNo"):
            lineno = self.lastLineNo
        self.lastLineNo = lineno
            
        if not change_type and hasattr(self, "lastChangeType"):
            change_type = self.lastChangeType
        self.lastChangeType = change_type

        old_ends_with_eol = new_ends_with_eol = True
        #XXX: Check old_ends_with_eol and new_ends_with_eol
        old_lines = []
        new_lines = []
        old_line_range = []
        new_line_range = []
        retval = [old_ends_with_eol, new_ends_with_eol,
                  old_line_range, new_line_range,
                  old_lines, new_lines]
        if change_type == self.CHANGES_DELETE:
            first_lineno = lineno
        else:
            first_lineno = self.first_interesting_line[lineno]
        old_line_range = None
        if change_type != self.CHANGES_INSERT:
            if change_type == self.CHANGES_REPLACE:
                lines_to_use = self.changed_text_line_range
            else:
                lines_to_use = self.deleted_text_line_range
            if first_lineno not in lines_to_use:
                log.warn("Can't find an entry for line %d in self.%s",
                         first_lineno,
                         ((change_type == self.CHANGES_REPLACE) and "changed_text_line_range"
                          or "deleted_text_line_range"))
                return retval
            old_line_range = lines_to_use[first_lineno]
            new_line_range = [first_lineno, first_lineno]  # If a deletion
            old_lines = [s.rstrip("\r\n") for s in
                        self._reference_lines[old_line_range[0]:old_line_range[1]]]
            if old_lines is None:
                # Failed to get those lines
                return retval
        # end if
        if change_type != self.CHANGES_DELETE:
            if  lineno not in self.first_interesting_line:
                log.warn("Can't find an entry for line %d in self.first_interesting_line (%r)",
                         lineno, self.first_interesting_line.keys())
                return retval
            if change_type == self.CHANGES_REPLACE:
                lines_to_use = self.last_modifications
            else:
                lines_to_use = self.last_insertions
            if first_lineno not in lines_to_use:
                log.warn("Can't find an entry for line %d in self.%s (%s)",
                         first_lineno,
                         ((change_type == self.CHANGES_REPLACE) and "changed_text_line_range"
                          or "last_insertions"),
                         lines_to_use.keys())
                return retval
            if not old_line_range:
                old_line_range = self.inserted_old_line_range[first_lineno]
            new_line_range = [first_lineno, lines_to_use[first_lineno]]
            scimoz = self.koDoc.getView().scimoz
            first_pos = scimoz.positionFromLine(new_line_range[0])
            last_pos = scimoz.getLineEndPosition(new_line_range[1] - 1)
            text = first_pos < last_pos and scimoz.getTextRange(first_pos, last_pos) or ""
            new_lines = text.splitlines()
            
        try:
            force_utf8 = lambda x: x.encode("utf8", 'strict')
            old_lines = map(force_utf8, old_lines)
            new_lines = map(force_utf8, new_lines)
        except Exception as ex:
            log.exception("Exception while trying to force UTF8: %s", ex)
        
        return [old_ends_with_eol, new_ends_with_eol,
                old_line_range, new_line_range,
                old_lines, new_lines]


