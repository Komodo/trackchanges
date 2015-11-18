/**
 * Tracker - manages the relationship between track changes UI (margin) and
 * the raw file changes (koIChangeTracker).
 */

var { Ci, Cr, Cc } = require("chrome");
var timers = require("sdk/timers");

const CHANGE_TRACKER_TIMEOUT_DELAY = 500; // msec

var log = require("ko/logging").getLogger("CT::tracker.js");
//log.setLevel(ko.logging.LOG_DEBUG);

exports.ChangeTracker = function ChangeTracker(view) {
    this.enabled = ko.prefs.getBoolean('trackchanges_enabled', true);
    this.view = view;
    this._timeoutId = null;
    // Watch for view preference changes.
    this.viewPrefObserverService = ko.prefs.prefObserverService;
    this.viewPrefObserverService.addObserver(this, 'trackchanges_enabled', false);

    if (!this.enabled) {
        return;
    }

    // Initialize.
    this.changeTrackingOn();
};

exports.ChangeTracker.prototype.QueryInterface = function (iid) {
    if (!iid.equals(Ci.koIChangeTrackerHandler) &&
        !iid.equals(Ci.nsISupports)) {
        throw Cr.NS_ERROR_NO_INTERFACE;
    }
    return this;
}

exports.ChangeTracker.prototype.close = function() {
    this.changeTrackingOff(true /*viewIsClosing*/);
    this.viewPrefObserverService.removeObserver(this, 'trackchanges_enabled', false);
    this.viewPrefObserverService = null;
    this.view = null;
};

exports.ChangeTracker.prototype.onSchemeChanged = function() {
    this.margin.refreshMarginProperies();
};

exports.ChangeTracker.prototype.getTooltipText = function(lineNo) {
    if (!this.isLineChanged(lineNo)) {
        return null;
    }
    var panel = document.getElementById('changeTracker_panel');
    if (panel && panel.state == "closed") {
        return require("sdk/l10n").get("Click on the changebar for details");
    }
    return null;
};

exports.ChangeTracker.prototype.changeTrackingOn = function() {
    // Create the margin.
    var margin = require("./margin");
    this.margin = new margin.MarginController(this.view);
    this.margin.showMargin();

    // Create the xpcom instance, to keep track of underlying file changes.
    const {Cc, Ci} = require("chrome");
    this.koChangeTracker = Cc["@activestate.com/koChangeTracker;1"].createInstance(Ci.koIChangeTracker);
    this.koChangeTracker.init(this.view.koDoc);
};

exports.ChangeTracker.prototype.changeTrackingOff = function(viewIsClosing) {
    if (!this.margin) {
        return;
    }
    if (!viewIsClosing) {
        this.margin.clear();
        this.margin.hideMargin();
    }
    this.margin.close();
    this.margin = null;
};

exports.ChangeTracker.prototype.getFormattedPatch = function() {
    var oldLines = {}, newLines = {}, oldLineRange = {}, newLineRange = {};
    var oldEndsWithEOL = {}, newEndsWithEOL = {};
    this.koChangeTracker.getOldAndNewLines(null, null,
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

    var partSvc = Cc["@activestate.com/koPartService;1"].getService(Ci.koIPartService);
    var curProject = partSvc.currentProject;
    var path = this.view.koDoc.file.path;
    if (curProject)
    {
        path = path.replace(curProject.liveDirectory, "");
    }
    else
    {
        var placesPath = ko.uriparse.URIToPath(ko.places.getDirectory());
        path = path.replace(placesPath, "");
    }

    var patch = "Index: " + this.view.koDoc.file.path + "\n";
    patch += "--- a" + path + "\n";
    patch += "+++ b" + path + "\n";
    patch += '@@ -'
     + (oldLineRange[0] + 1)
     + ','
     + (oldLineRange[1] - oldLineRange[0])
     + ' +'
     + (newLineRange[0] + 1)
     + ','
     + (newLineRange[1] - newLineRange[0])
     + ' @@' + "\n";

    var editor = require("ko/editor");
    patch += " " + editor.getLine(newLineRange[0]) + "\n";
    patch += oldLines.map(function(s) '-' + s).join("\n") + "\n";
    patch += newLines.map(function(s) '+' + s).join("\n") + "\n";
    patch += " " + editor.getLine(newLineRange[1] + 1) + "\n";

    return patch;
}

exports.ChangeTracker.prototype.observe = function(doc, topic, data) {
    if (topic == 'trackchanges_enabled') {
        this.enabled = ko.prefs.getBoolean(topic, true);
        if (this.enabled) {
            this.changeTrackingOn();
            // Show updates immediately.
            this.update();
        } else {
            this.changeTrackingOff();
        }
    }
};

/**
 * Get latest changes and update the margins accordingly.
 */
exports.ChangeTracker.prototype.update = function() {
    if (!this.enabled || !this.koChangeTracker) {
        return;
    }
    log.debug("ChangeTracker::update");
    try {
        this.koChangeTracker.updateChangeTracker(this);
    } catch(ex) {
        log.exception(ex, "updateChangeTracker failed: ");
    }
}

/**
 * Delayed update call.
 */
exports.ChangeTracker.prototype.updateWithDelay = function() {
    // Remove the old timer.
    if (this._timeoutId !== null)
        timers.clearTimeout(this._timeoutId);
    // Create the new timer.
    log.debug("ChangeTracker::updateWithDelay " + CHANGE_TRACKER_TIMEOUT_DELAY);
    this._timeoutId = timers.setTimeout(this.update.bind(this), CHANGE_TRACKER_TIMEOUT_DELAY);
};

/**
 * Mark the existing buffer contents as 'saved' for collaborative documents.
 * Changes from this current state will now be tracked.
 */
exports.ChangeTracker.prototype.collabStoreState = function() {
    if (!this.enabled || !this.koChangeTracker) {
        return;
    }
    log.debug("ChangeTracker::collabStoreState");
    try {
        this.koChangeTracker.collabStoreState();
        this.update(); // clear all change markers
    } catch(ex) {
        log.exception(ex, "collabStoreState failed: ");
    }
}

exports.ChangeTracker.prototype.isLineChanged = function(lineNo) {
    return this.margin.changeTypeAtLine(lineNo) !== 0;
};

/**
 * koIChangeTrackerHandler implementation.
 */
exports.ChangeTracker.prototype.onError = function (message) {
    log.error(message);
}
exports.ChangeTracker.prototype.markChanges = function (dcount, deletions, icount, insertions, mcount, modifications) {
    if (!this.margin) {
        // This may happen in collab documents where `markChanges()` is called
        // before `this.margin` is initialized. Normally async callbacks are
        // used with filesystem files, which gives `this.margin` enough time to
        // initialize.
        return;
    }
    this.margin.markChanges(deletions, insertions, modifications);
};

/**
 * Open popup dialog that shows the changes for the given line number.
 */
exports.ChangeTracker.prototype.showChanges = function(lineNo) {
    var dialog = require("./dialog");
    dialog.showChanges(this, lineNo);
}

/**
 * Find and move to the next change in the document.
 */
exports.ChangeTracker.prototype.moveToNextChange = function() {
    this.margin.moveToNextChange();
}

/**
 * Find and move to the previous change in the document.
 */
exports.ChangeTracker.prototype.moveToPreviousChange = function() {
    this.margin.moveToPreviousChange();
}
