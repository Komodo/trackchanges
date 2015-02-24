/* Track changes: keep track of editor buffers and allow changes to be shown.
 *
 * Manages the (per view) tracker instances, setting up and tearing down where
 * appropriate.
 *
 * See KD 295: Track Changes
 */

if (typeof(ko) === 'undefined') {
    var ko = {};
}
if (typeof(ko.changeTracker) === 'undefined') {
    ko.changeTracker = {};
}

(function() {

var log = require("ko/logging").getLogger("CT::trackchanges.js");
//log.setLevel(ko.logging.LOG_INFO);

const MARGIN_CHANGEMARGIN = Ci.ISciMoz.MARGIN_TRACKING;

/**
 * Responsible for creating and deleting ChangeTracker objects, and associating
 * each one with a view.
 */

this.init = function() {
    this.onViewOpenedHandlerBound = this.onViewOpenedHandler.bind(this);
    this.onViewClosedHandlerBound = this.onViewClosedHandler.bind(this);
    this.onWindowClosingHandlerBound = this.onWindowClosingHandler.bind(this);
    this.onEditorTextModifiedBound = this.onEditorTextModified.bind(this);
    this.onEditorMarginClickedBound = this.onEditorMarginClicked.bind(this);
    this.onMarginGetTooltipTextBound = this.onMarginGetTooltipText.bind(this);
    window.addEventListener('editor_margin_get_tooltiptext', this.onMarginGetTooltipTextBound, true);
    window.addEventListener('editor_margin_clicked', this.onEditorMarginClickedBound, true);
    window.addEventListener("editor_text_modified", this.onEditorTextModifiedBound, false);
    window.addEventListener('view_document_attached', this.onViewOpenedHandlerBound, false);
    window.addEventListener('view_document_detaching', this.onViewClosedHandlerBound, false);
    window.addEventListener('unload', this.onWindowClosingHandlerBound, false);

    Services.obs.addObserver(this, "file_status", false);

    // And because this method might have been called after documents were
    // loaded, we need to set up the changeTracker for existing ones.
    ko.views.manager.getAllViews('editor').forEach(function(view) {
        if (!('changeTracker' in view)) {
            //log.debug(">> force an open view for " + view.koDoc.displayPath);
            this.onViewOpenedHandler({originalTarget: view});
        }
    }.bind(this));

    var panel = document.getElementById('changeTracker_panel');
    panel.addEventListener("keydown", function(e) {
        // won't work on OSX, no idea why - OSX just WILL NOT focus the panel
        if (e.keyCode == 27) { // escape
            panel.hidePopup();
        }
    });

    // OSX does not properly handle panel focus, so we have to get creative
    // when figuring out if the click was on our panel or not
    // https://bugs.activestate.com/show_bug.cgi?id=106316
    window.addEventListener("mouseup", function(e) {
        if (panel.state == "closed" || panel.state == "hiding") return;
        var bo = panel.boxObject;
        if (e.clientX >= bo.x && e.clientX < (bo.x + bo.width)) return;
        if (e.clientY >= bo.y && e.clientY < (bo.y + bo.height)) return;
        panel.hidePopup();
    });
};

this.onWindowClosingHandler = function() {
    window.removeEventListener('editor_margin_get_tooltiptext', this.onMarginGetTooltipTextBound, false);
    window.removeEventListener('editor_margin_clicked', this.onEditorMarginClickedBound, false);
    window.removeEventListener('editor_text_modified', this.onEditorTextModifiedBound, false);
    window.removeEventListener('view_document_attached', this.onViewOpenedHandlerBound, false);
    window.removeEventListener('view_document_detaching', this.onViewClosedHandlerBound, false);
    window.removeEventListener('unload', this.onWindowClosingHandlerBound, false);

    Services.obs.removeObserver(this, "file_status");
};

this.observe = function(subject, topic, data) {
    if (topic == "file_status") {
        var urllist = data.split('\n');
        var view, views;
        for (var u=0; u < urllist.length; ++u) {
            views = ko.views.manager.topView.findViewsForURI(urllist[u]);
            for (var i=0; i < views.length; ++i) {
                view = views[i];
                if ('changeTracker' in view && view.changeTracker.enabled) {
                    view.changeTracker.updateWithDelay();
                }
            }
        }
    }
}

this.onViewOpenedHandler = function(event) {
    var view = event.originalTarget;
    if (view.getAttribute("type") != "editor") {
        return;
    }

    var tracker = require("trackchanges/tracker");
    view.changeTracker = new tracker.ChangeTracker(view);

    if (view.changeTracker.enabled) {
        // TODO: Delay initialization for batch files.
        //if (!ko.views.manager.batchMode) {
        view.changeTracker.updateWithDelay();
    }
};

this.onViewClosedHandler = function(event) {
    var view = event.originalTarget;
    if (view.changeTracker) {
        view.changeTracker.close();
        view.changeTracker = null;
    }
};

const AllowedModifications = (Ci.ISciMoz.SC_MOD_INSERTTEXT |Ci.ISciMoz.SC_MOD_DELETETEXT);
this.onEditorTextModified = function(event) {
    try {
        if ((event.data.modificationType & AllowedModifications) == 0) {
            return;
        }
        var view = event.data.view;
        var changeTracker = view.changeTracker;
        if (!changeTracker || !changeTracker.enabled) {
            return;
        }
        changeTracker.updateWithDelay();
    } catch(ex) {
        log.exception(ex, "changeTracker error: onEditorTextModified");
    }
};

this.onEditorMarginClicked = function(event) {
    try {
        if (event.detail.margin != MARGIN_CHANGEMARGIN) {
            return;
        }
        var view = event.detail.view;
        if (view.changeTracker && view.changeTracker.enabled) {
            view.changeTracker.showChanges(event.detail.line);
            // Mark the event as handled.
            event.preventDefault();
        }
    } catch(ex) {
        log.exception(ex, "changeTracker error: onEditorMarginClicked");
    }
};

this.onMarginGetTooltipText = function(event) {
    try {
        // Hovering over a change-margin?
        if (event.detail.margin == MARGIN_CHANGEMARGIN) {
            var view = event.detail.view;
            if (view.changeTracker && view.changeTracker.enabled) {
                let text = view.changeTracker.getTooltipText(event.detail.line);
                if (text) {
                    event.detail.text = text;
                    // Mark the event as handled.
                    event.preventDefault();
                }
            }
        }
    } catch(ex) {
        log.exception(ex, "changeTracker error: onMarginGetTooltipText");
    }
};

this.moveToNextChange = function(event) {
    try {
        var view = ko.views.manager.currentView;
        if (view && view.changeTracker && view.changeTracker.enabled) {
            view.changeTracker.moveToNextChange();
        }
    } catch(ex) {
        log.exception(ex, "changeTracker error: moveToNextChange");
    }
}

this.moveToPreviousChange = function(event) {
    try {
        var view = ko.views.manager.currentView;
        if (view && view.changeTracker && view.changeTracker.enabled) {
            view.changeTracker.moveToPreviousChange();
        }
    } catch(ex) {
        log.exception(ex, "changeTracker error: moveToPreviousChange");
    }
}

}).apply(ko.changeTracker);


window.addEventListener("komodo-ui-started", ko.changeTracker.init.bind(ko.changeTracker), false);

// TODO: Listen for pref changes and update accordingly.
//  'trackchanges_enabled',
//  'editor-scheme',
//  'scheme-changed',
