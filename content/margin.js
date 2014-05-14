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
    // Remember the margin change positions.
    this.previous_deletions = new Set();
    this.previous_insertions = new Set();
    this.previous_replacements = new Set();
    // Setup the margin styling.
    this.refreshMarginProperies();
};

exports.MarginController.prototype = {
    constructor: this.MarginController,

    _initMarkerStyles: function() {
        const scimoz = this.view.scimoz;

        var insertColor, deleteColor, replaceColor;

        // Get the track changes colors directly from the color scheme.
        try {
            insertColor = this.view.scheme.getColor("changeMarginInserted");
        } catch(ex) {
            log.exception(ex, "couldn't get the insert-color");
            insertColor = 0xa3dca6; // BGR for a muted green
        }
        try {
            deleteColor = this.view.scheme.getColor("changeMarginDeleted");
        } catch(ex) {
            log.exception(ex, "couldn't get the delete-color");
            deleteColor = 0x5457e7; // BGR for a muted red
        }
        try {
            replaceColor = this.view.scheme.getColor("changeMarginReplaced");
        } catch(e) {
            log.exception(ex, "couldn't get the change-color");
            replaceColor = 0xe8d362; // BGR for a muted blue
        }

        // Define scintilla markers.
        scimoz.markerDefine(MARKER_INSERTION, scimoz.SC_MARK_LEFTRECT)
        scimoz.markerSetBack(MARKER_INSERTION, insertColor);

        scimoz.markerDefine(MARKER_DELETION, scimoz.SC_MARK_LEFTRECT)
        scimoz.markerSetBack(MARKER_DELETION, deleteColor);

        scimoz.markerDefine(MARKER_REPLACEMENT, scimoz.SC_MARK_LEFTRECT)
        scimoz.markerSetBack(MARKER_REPLACEMENT, replaceColor);
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

    clear: function() {
        // We can't use the held deletion/insertion lists because the line numbers
        // could have changed.
        const scimoz = this.view.scimoz;
        scimoz.markerDeleteAll(MARKER_INSERTION);
        scimoz.markerDeleteAll(MARKER_DELETION);
        scimoz.markerDeleteAll(MARKER_REPLACEMENT);
        this.previous_deletions = new Set();
        this.previous_insertions = new Set();
        this.previous_replacements = new Set();
    },

    clearLineNos: function(lineNos, markerNum) {
        // We can't use the cahced deletion/insertion lists because the line
        // numbers may have changed since the cache was updated.
        const scimoz = this.view.scimoz;
        const markerMask = (1 << markerNum);
        for (let lineNo of lineNos) {
            if (!scimoz.markerGet(lineNo) & markerMask) {
                return CACHE_OUT_OF_DATE;
            }
            scimoz.markerDelete(lineNo, markerNum);
        }
        return CACHE_VALID;
    },

    activeMarkerMask: function(lineNo) {
        if (this.previous_deletions.has(lineNo))
            return 1 << CHANGES_DELETE;
        if (this.previous_insertions.has(lineNo))
            return 1 << CHANGES_INSERT;
        if (this.previous_replacements.has(lineNo))
            return 1 << CHANGES_REPLACE;
        return 0;
    },

    markChanges: function(deletions, insertion_ranges, replacement_ranges) {
        var linesFromLineRange = function(range) {
            var linenos = [];
            for (var i=0; i < range.length; i += 2) {
                var endLine = range[i+1];
                for (var j=range[i]; j < endLine; j++) {
                    linenos.push(j);
                }
            }
            return linenos;
        }

        // TODO: This caching code is quite complicated - perhaps it's just
        //       better to just delete all markers and just re-add them.

        // Turn into sets of line numbers.
        deletions = new Set(deletions);
        var insertions = new Set(linesFromLineRange(insertion_ranges));
        var replacements = new Set(linesFromLineRange(replacement_ranges));

        // Determine old margin entries that need removal.
        var expired_deletions = [x for (x of this.previous_deletions) if (!(deletions.has(x)))];
        var expired_insertions = [x for (x of this.previous_insertions) if (!(insertions.has(x)))];
        var expired_replacements = [x for (x of this.previous_replacements) if (!(replacements.has(x)))];
        // Remove the expired entries.
        if (this.clearLineNos(expired_deletions, MARKER_DELETION) == CACHE_OUT_OF_DATE ||
            this.clearLineNos(expired_insertions, MARKER_INSERTION) == CACHE_OUT_OF_DATE ||
            this.clearLineNos(expired_replacements, MARKER_REPLACEMENT) == CACHE_OUT_OF_DATE)
        {
            // Cache is out-of-date, reset all entries.
            log.info("Cache is out of date (deleted positions) - clearing");
            this.clear();
        }

        const scimoz = this.view.scimoz;
        var margin = this;

        // Check the cached change positions that are not getting modified in this update.
        var unchanged_deletions = [x for (x of this.previous_deletions) if ((deletions.has(x)))];
        var unchanged_insertions = [x for (x of this.previous_insertions) if ((insertions.has(x)))];
        var unchanged_replacements = [x for (x of this.previous_replacements) if ((replacements.has(x)))];
        if (unchanged_deletions.some(function(lineNo) {
                return !(scimoz.markerGet(lineNo) & MARKER_DELETION_MASK);
            }) ||
            unchanged_insertions.some(function(lineNo) {
                return !(scimoz.markerGet(lineNo) & MARKER_INSERTION_MASK);
            }) ||
            unchanged_replacements.some(function(lineNo) {
                return !(scimoz.markerGet(lineNo) & MARKER_REPLACEMENT_MASK);
            }))
        {
            // Cache is out-of-date, reset all entries.
            log.info("Cache is out of date (unchanged positions) - clearing");
            this.clear();
        }

        // Determine new replacement positions, that don't already exist.
        var new_deletions = [x for (x of deletions) if (!(this.previous_deletions.has(x)))];
        var new_insertions = [x for (x of insertions) if (!(this.previous_insertions.has(x)))];
        var new_replacements = [x for (x of replacements) if (!(this.previous_replacements.has(x)))];

        // Add the new deletion positions.
        new_deletions.forEach(function(lineNo) {
            scimoz.markerAdd(lineNo, MARKER_DELETION);
        });
        // Add the new insertion positions.
        new_insertions.forEach(function(lineNo) {
            scimoz.markerAdd(lineNo, MARKER_INSERTION);
        });
        // Add the new replacement positions.
        new_replacements.forEach(function(lineNo) {
            scimoz.markerAdd(lineNo, MARKER_REPLACEMENT);
        });

        // And store them for the next time.
        this.previous_deletions = deletions;
        this.previous_insertions = insertions;
        this.previous_replacements = replacements;
    },

    __EOF__: null
};

