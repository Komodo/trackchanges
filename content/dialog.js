const { Cc, Ci } = require("chrome");
const color = require("ko/color");

var log = require("ko/logging").getLogger("CT::dialog.js");
log.setLevel(ko.logging.LOG_DEBUG);

var fileSvc = Cc["@activestate.com/koFileService;1"].getService(Ci.koIFileService);

exports.showChanges = function(tracker, lineNo) {
    var changeType = tracker.margin.changeTypeAtLine(lineNo);
    if (!changeType) {
        return;
    }

    var oldLines = {}, newLines = {}, oldLineRange = {}, newLineRange = {};
    var oldEndsWithEOL = {}, newEndsWithEOL = {};
    tracker.koChangeTracker.getOldAndNewLines(lineNo, changeType,
                                              oldEndsWithEOL,
                                              newEndsWithEOL,
                                              {}, oldLineRange,
                                              {}, newLineRange,
                                              {}, oldLines,
                                              {}, newLines);
    oldLineRange = oldLineRange.value;
    newLineRange = newLineRange.value;
    oldLines = oldLines.value;
    newLines = newLines.value;
    if (!oldLines.length && !newLines.length) {
        return;
    }

    // Write htmlLines to a temp file, get the URL, and then create a panel
    // with that iframe/src
    var htmlFile = fileSvc.makeTempFile(".html", 'wb');
    var htmlURI = htmlFile.URI;
    var lastDot = htmlURI.lastIndexOf('.');

    const missingNewline = "<span class='comment'>\\ No newline at end of file</span>";
    var noNewlineAtEndOfOldLines  = !oldEndsWithEOL ? [missingNewline] : [];
    var noNewlineAtEndOfNewLines  = !newEndsWithEOL ? [missingNewline] : [];
    // Convert Scintilla colors to hex RGB colors.
    var oldColor = color.longToHex(color.BGRToRGB(tracker.margin.deleteColor));
    var newColor = color.longToHex(color.BGRToRGB(tracker.margin.insertColor));

    var view = ko.views.manager.currentView
    var scheme = view.scheme;
    var fontFamily = scheme.getFont("default");
    var fontSize = scheme.getSize(view.koDoc.language, "default");

    var escapeLines = function(textLines, prefix) {
        return textLines.map(function(s) {
            return prefix + s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        })
    }

    //TODO:
    // Make a (EJS?) template for this.
    // Build up diffCodes = this.view.koDoc.diffStringsAsChangeInstructions(lineBefore, lineAfter);
    // and use that info to show how lines differ internally.
    var htmlLines = [
        '<html>',
        '<head>',
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
        '<link rel="stylesheet" type="text/css" href="less://trackchanges/skin/trackchanges.less">',
        '<style>',
        'body {',
        '   font-family: ' + fontFamily + ' !important;',
        '   font-size: ' + fontSize + 'pt !important;',
        '}',
        '</style>',
        '<body id="changeTrackerFrame">',
        '<pre class="header">',
        ('@@ -'
         + (oldLineRange[0] + 1)
         + ','
         + (oldLineRange[1] + 1)
         + ' +'
         + (newLineRange[0] + 1)
         + ','
         + (newLineRange[1] + 1)
         + ' @@'),
        '</pre>',
        '<pre disabled="true" class="old">'].
    concat(escapeLines(oldLines, "-")).
    concat(noNewlineAtEndOfOldLines).
    concat([
        '</pre>',
        '<pre disabled="true" class="new">',]).
    concat(escapeLines(newLines, "+")).
    concat(noNewlineAtEndOfNewLines).
    concat([
            '</pre>',
            '</html>',
            '']);
    htmlFile.puts(htmlLines.join("\n"));
    htmlFile.close();

    var scimoz = tracker.view.scimoz;
    var undoTextFunc = function(event) {
        // Find the (j2 - j1) new lines at j2, remove them, and
        // replace with the (i2 - i1) old lines.
        scimoz.beginUndoAction();
        try {
            let j1Pos = scimoz.positionFromLine(newLineRange[0]);
            if (newLineRange[0] < newLineRange[1]) {
                let j2Pos = scimoz.positionFromLine(newLineRange[1]);
                // Verify that the lines in the editor correspond to the
                // lines we have here before zapping them.
                scimoz.targetStart = j1Pos;
                scimoz.targetEnd = j2Pos;
                scimoz.replaceTarget(0, "");
            }
            if (oldLineRange[0] < oldLineRange[1]) {
                let eol = ["\r\n", "\r", "\n"][scimoz.eOLMode];
                let oldText = oldLines.join(eol);
                if (oldEndsWithEOL) {
                    oldText += eol;
                }
                scimoz.targetStart = j1Pos;
                scimoz.targetEnd = j1Pos;
                scimoz.replaceTarget(oldText);
            }
            document.getElementById('changeTracker_panel').hidePopup();
        } catch(ex) {
            log.exception(ex, "Can't undo a change");
        } finally {
            scimoz.endUndoAction();
        }
    };
    // Now make a panel with an iframe, point the iframe to htmlURI, and go
    this.createPanel(tracker, htmlFile, undoTextFunc);
};

exports.createPanel = function(tracker, htmlFile, undoTextFunc) {
    var view = tracker.view;
    var panel = document.getElementById('changeTracker_panel');
    panel.hidePopup();
    var iframe = panel.getElementsByTagName("iframe")[0];
    var undoButton = document.getElementById('changeTracker_undo');
    iframe.setAttribute("src", htmlFile.URI);
    var [x, y] = view._last_mousemove_xy;

    // Event handlers.
    var panelBlurHandler = function(event) {
        panel.hidePopup();
    };
    var escapeHandler = function(event) {
        if (event.keyCode == event.DOM_VK_ESCAPE) {
            panel.hidePopup();
            event.stopPropagation();
            event.preventDefault();
        }
    };
    var iframeLoadedFunc = function(event) {
        try {
            var iframe = panel.getElementsByTagName("iframe")[0];

            panel.openPopup(view, "after_pointer", x, y, false, false);

            if ( ! ("initDim" in panel))
            {
                panel.initDim = {
                    height: panel.boxObject.height
                }
            }

            var body = iframe.contentWindow.document.body;

            iframe.initDim = {
                height: body.scrollHeight
            }

            iframe.style.height = (body.offsetHeight + 10) + "px";
            
            fileSvc.deleteTempFile(htmlFile.path, true);
            undoButton.addEventListener("command", undoTextFunc, false);
        } catch(ex) {
            log.exception(ex, "problem in iframeLoadedFunc\n");
        }
    }
    var panelHiddenFunc = function(event) {
        undoButton.removeEventListener("command", undoTextFunc, false);
        iframe.removeEventListener("load", iframeLoadedFunc, true);
        panel.removeEventListener("popuphidden", panelHiddenFunc, false);
        panel.removeEventListener("keypress", escapeHandler, false);
        panel.removeEventListener("blur", panelBlurHandler, false);
        view.removeEventListener("focus", panelBlurHandler, false);
    };

    iframe.addEventListener("load", iframeLoadedFunc, true);
    panel.addEventListener("popuphidden", panelHiddenFunc, true);
    panel.addEventListener("keypress", escapeHandler, false);
    panel.addEventListener("blur", panelBlurHandler, false);
    view.addEventListener("focus", panelBlurHandler, false);
};
