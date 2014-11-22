/**
 * Tracker - manages the relationship between track changes UI (margin) and
 * the raw file changes (koIChangeTracker).
 */

var { Ci, Cr } = require("chrome");
var timers = require("sdk/timers");

const CHANGE_TRACKER_TIMEOUT_DELAY = 500; // msec

var log = require("ko/logging").getLogger("CT::tracker.js");
//log.setLevel(ko.logging.LOG_DEBUG);

exports.ChangeTracker = function ChangeTracker(view) {
    this.enabled = view.prefs.getBoolean('trackchanges_enabled', true);
    this.view = view;
    this._timeoutId = null;
    // Watch for view preference changes.
    this.viewPrefObserverService = view.prefs.prefObserverService;
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

exports.ChangeTracker.prototype.observe = function(doc, topic, data) {
    if (topic == 'trackchanges_enabled') {
        this.enabled = this.view.prefs.getLong(topic, true);
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

exports.ChangeTracker.prototype.isLineChanged = function(lineNo) {
    return this.margin.changeTypeAtLine(lineNo) !== 0;
};

/**
 * koIChangeTrackerHandler implementation.
 */
exports.ChangeTracker.prototype.onError = function (message) {
    ko.statusBar.AddMessage(message, "ChangeTracker", 3000, true);
}
exports.ChangeTracker.prototype.markChanges = function (dcount, deletions, icount, insertions, mcount, modifications) {
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
