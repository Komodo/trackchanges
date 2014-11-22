/**
 * Margin - manages the scintilla margin to show file changes.
 */

const { Ci } = require("chrome");
const color = require("ko/color");

const MARGIN_TEXT_LENGTH = 1;
const MARGIN_CHANGEMARGIN = Ci.ISciMoz.MARGIN_TRACKING;
const MARGIN_CHANGEMARGIN_WIDTH = 6; // pixels

// Scintilla margin marker numbers - should not collide with any other margins.
const MARKER_INSERTION = 22;
const MARKER_DELETION = 23;
const MARKER_REPLACEMENT = 24;

const MARKER_MASK = (1 << MARKER_INSERTION) | (1 << MARKER_DELETION) | (1 << MARKER_REPLACEMENT)
const MARKER_INSERTION_MASK = (1 << MARKER_INSERTION);
const MARKER_DELETION_MASK = (1 << MARKER_DELETION);
const MARKER_REPLACEMENT_MASK = (1 << MARKER_REPLACEMENT);

const CHANGES_NONE = Ci.koIChangeTracker.CHANGES_NONE;
const CHANGES_INSERT = Ci.koIChangeTracker.CHANGES_INSERT;
const CHANGES_DELETE = Ci.koIChangeTracker.CHANGES_DELETE;
const CHANGES_REPLACE = Ci.koIChangeTracker.CHANGES_REPLACE;

// Used for checking the marker position cache.
const CACHE_VALID = 0;
const CACHE_OUT_OF_DATE = 1;

var log = require("ko/logging").getLogger("CT::margin.js");
//log.setLevel(log.INFO);

exports.MarginController = function MarginController(view) {
    this.view = view;
    // Default scintilla marker colors - in BGR format.
    this.insertColor = 0xa3dca6; // BGR for a muted green
    this.deleteColor = 0x5457e7; // BGR for a muted red
    this.replaceColor = 0xe8d362; // BGR for a muted blue
    // Setup the margin styling.
    this.refreshMarginProperies();
};

exports.MarginController.prototype = {
    constructor: this.MarginController,

    _initMarkerStyles: function() {
        const scimoz = this.view.scimoz;

        // Get the track changes colors directly from the color scheme.
        // Note that scintilla uses BGR color values (urgh).
        try {
            this.insertColor = this.view.scheme.getScintillaColor("changeMarginInserted");
        } catch(ex) {
            log.exception(ex, "couldn't get the insert-color");
        }
        try {
            this.deleteColor = this.view.scheme.getScintillaColor("changeMarginDeleted");
        } catch(ex) {
            log.exception(ex, "couldn't get the delete-color");
        }
        try {
            this.replaceColor = this.view.scheme.getScintillaColor("changeMarginReplaced");
        } catch(e) {
            log.exception(ex, "couldn't get the change-color");
        }

        // Define scintilla markers.
        scimoz.markerDefine(MARKER_INSERTION, scimoz.SC_MARK_LEFTRECT)
        scimoz.markerSetBack(MARKER_INSERTION, this.insertColor);

        scimoz.markerDefine(MARKER_DELETION, scimoz.SC_MARK_LEFTRECT)
        scimoz.markerSetBack(MARKER_DELETION, this.deleteColor);

        scimoz.markerDefine(MARKER_REPLACEMENT, scimoz.SC_MARK_LEFTRECT)
        scimoz.markerSetBack(MARKER_REPLACEMENT, this.replaceColor);
    },

    _initMargin: function() {
        var scimoz = this.view.scimoz;
        scimoz.setMarginTypeN(MARGIN_CHANGEMARGIN, scimoz.SC_MARGIN_SYMBOL);
        // If someone else is using the margin, respect their mask settings.
        var existing_markermask = scimoz.getMarginMaskN(MARGIN_CHANGEMARGIN);
        scimoz.setMarginMaskN(MARGIN_CHANGEMARGIN, existing_markermask | MARKER_MASK);
        scimoz.setMarginWidthN(MARGIN_CHANGEMARGIN, MARGIN_CHANGEMARGIN_WIDTH);
        scimoz.setMarginSensitiveN(MARGIN_CHANGEMARGIN, true);
    },


    /**
     * Margin API.
     */

    close: function() {
        this.view = null;
    },

    showMargin: function() {
        this.view.scimoz.setMarginWidthN(MARGIN_CHANGEMARGIN, MARGIN_CHANGEMARGIN_WIDTH);
    },

    hideMargin: function() {
        this.view.scimoz.setMarginWidthN(MARGIN_CHANGEMARGIN, 0);
    },

    refreshMarginProperies: function refreshMarginProperies() {
        this._initMarkerStyles();
        this._initMargin();
    },

    clear: function(scimoz) {
        // We can't use the held deletion/insertion lists because the line numbers
        // could have changed.
        if (!scimoz) {
            scimoz = this.view.scimoz;
        }
        scimoz.markerDeleteAll(MARKER_INSERTION);
        scimoz.markerDeleteAll(MARKER_DELETION);
        scimoz.markerDeleteAll(MARKER_REPLACEMENT);
    },

    changeTypeAtLine: function(lineNo) {
        const scimoz = this.view.scimoz;
        const markerMask = scimoz.markerGet(lineNo) & MARKER_MASK;
        if (!markerMask) {
            return CHANGES_NONE;
        }
        if (markerMask & MARKER_INSERTION_MASK) {
            return CHANGES_INSERT;
        }
        if (markerMask & MARKER_DELETION_MASK) {
            return CHANGES_DELETE;
        }
        if (markerMask & MARKER_REPLACEMENT_MASK) {
            return CHANGES_REPLACE;
        }
        return CHANGES_NONE;
    },

    markChanges: function(deletions, insertion_ranges, replacement_ranges) {
        var genLinesFromLineRange = function(range) {
            for (let i=0; i < range.length; i += 2) {
                let endLine = range[i+1];
                for (let j=range[i]; j < endLine; j++) {
                    yield j;
                }
            }
        }

        const scimoz = this.view.scimoz;

        var updateLineMarkers = function(lineNos, marker) {
            let marker_mask = (1 << marker);
            let next = scimoz.markerNext(0, marker_mask);
            for (let lineNo of lineNos) {
                while (next >= 0 && next < lineNo) {
                    // Remove stale markers.
                    scimoz.markerDelete(next, marker);
                    next = scimoz.markerNext(next+1, marker_mask);
                }
                if (next == lineNo) {
                    // Already a marker here.
                    next = scimoz.markerNext(next+1, marker_mask);
                    continue;
                }
                scimoz.markerAdd(lineNo, marker);
            }
            // Remove any markers beyond the last updated position.
            while (next >= 0) {
                scimoz.markerDelete(next, marker);
                next = scimoz.markerNext(next+1, marker_mask);
            }
        }

        // Update the marker positions.
        updateLineMarkers(deletions, MARKER_DELETION);
        updateLineMarkers(genLinesFromLineRange(insertion_ranges), MARKER_INSERTION);
        updateLineMarkers(genLinesFromLineRange(replacement_ranges), MARKER_REPLACEMENT);
    },

    moveToNextChange: function() {
        const scimoz = this.view.scimoz;
        let lineNo = scimoz.lineFromPosition(scimoz.currentPos);
        let nextNo = scimoz.markerNext(lineNo+1, MARKER_MASK);
        if (nextNo != -1) {
            scimoz.gotoPos(scimoz.positionFromLine(nextNo));
            this.view.verticallyAlignCaret("onethird");
            scimoz.chooseCaretX();
        }
    },

    moveToPreviousChange: function() {
        const scimoz = this.view.scimoz;
        let lineNo = scimoz.lineFromPosition(scimoz.currentPos);
        let nextNo = scimoz.markerPrevious(lineNo-1, MARKER_MASK);
        if (nextNo != -1) {
            scimoz.gotoPos(scimoz.positionFromLine(nextNo));
            this.view.verticallyAlignCaret("onethird");
            scimoz.chooseCaretX();
        }
    },

    __EOF__: null
};

