/**
 * Tracker - manages the relationship between track changes UI (margin) and
 * the raw file changes (koIChangeTracker).
 */

var { Ci, Cr } = require("chrome");
var timers = require("sdk/timers");

const CHANGE_TRACKER_TIMEOUT_DELAY = 500; // msec

var log = require("ko/logging").getLogger("CT::tracker.js");
//log.setLevel(ko.logging.LOG_INFO);

exports.ChangeTracker = function ChangeTracker(view) {
    this.enabled = view.prefs.getBoolean('trackchanges_enabled', true);
    this.view = view;
    this._timeoutId = null;
    // Watch for view preference changes.
    this.viewPrefObserverService = view.prefs.prefObserverService;
    this.viewPrefObserverService.addObserver(this, 'trackchanges_enabled', false);
    // Bind common event handlers.
    this.onBlurHandlerBound = this.onBlurHandler.bind(this);
    this.escapeHandlerBound = this.escapeHandler.bind(this);

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

exports.ChangeTracker.prototype.onBlurHandler = function(event) {
    // Have we shown the panel and moved to a different document?
    let panel = document.getElementById('changeTracker_panel');
    if (panel.state != "closed" && panel.view != ko.views.manager.currentView) {
        panel.hidePopup();
        this.onPanelHide();
    }
};

exports.ChangeTracker.prototype.changeTrackingOn = function() {
    // Create the margin.
    var margin = require("./margin");
    this.margin = new margin.MarginController(this.view);
    this.margin.showMargin();
    this.view.addEventListener("blur", this.onBlurHandlerBound, false);

    // Create the xpcom instance, to keep track of underlying file changes.
    const {Cc, Ci} = require("chrome");
    this.koChangeTracker = Cc["@activestate.com/koChangeTracker;1"].createInstance(Ci.koIChangeTracker);
    this.koChangeTracker.init(this.view.koDoc);
};

exports.ChangeTracker.prototype.changeTrackingOff = function(viewIsClosing) {
    if (!viewIsClosing) {
        this.margin.clear();
        this.margin.hideMargin();
    }
    this.margin.close();
    this.margin = null;
    this.view.removeEventListener("blur", this.onBlurHandlerBound, false);
};

exports.ChangeTracker.prototype.onPanelShow = function() {
    this.view.addEventListener("keypress", this.escapeHandlerBound, false);
};

exports.ChangeTracker.prototype.onPanelHide = function() {
    this.view.removeEventListener("keypress", this.escapeHandlerBound, false);
};

exports.ChangeTracker.prototype.escapeHandler = function(event) {
    var panel = document.getElementById('changeTracker_panel');
    // If the panel's visible should we close it on any keystroke,
    // when the target is the view?
    if (event.keyCode == event.DOM_VK_ESCAPE || panel.state == "closed") {
        panel.hidePopup();
        this.onPanelHide();
        event.stopPropagation();
        event.preventDefault();
    }
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
    this._timeoutId = timers.setTimeout(this.update.bind(this), CHANGE_TRACKER_TIMEOUT_DELAY);
};

exports.ChangeTracker.prototype.isLineChanged = function(lineNo) {
    var changeMask = this.margin.activeMarkerMask(lineNo);
    return changeMask !== 0;
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
