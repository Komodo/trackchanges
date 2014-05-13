/**
 * Margin - manages the scintilla margin to show file changes.
 */

const { Ci } = require("chrome");
const color = require("ko/color");

const MARGIN_TEXT_LENGTH = 1;
const MARGIN_CHANGEMARGIN = Ci.ISciMoz.MARGIN_TRACKING;

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

    _fix_rgb_color: function _fix_rgb_color(cssColor) {
        if (cssColor[0] == "#") {
            if (cssColor.length == 4) {
                return parseInt(cssColor[1] + cssColor[1] +
                                cssColor[2] + cssColor[2] +
                                cssColor[3] + cssColor[3], 16);
            }
            // Strip off the '#' and parse as is.
            // Most of the time there will be 6 hexdigits.
            return parseInt(cssColor.substring(1), 16);
        }
        return cssColor;
    },

    getColorAsHexRGB: function(colorAction) {
        return this[colorAction + "RGBColor"];
    },

    _initMarkerStyles: function(markerStyleSteps) {
        const styleOffset = 255;
        const marginCharacterSize = 6;
        const scimoz = this.view.scimoz;
        scimoz.marginStyleOffset = styleOffset;

        var insertColor, deleteColor, replaceColor;
        var bgr_string_to_rgb_array = function(cssColor) {
            var red, green, blue, x;
            if (typeof(cssColor) == "string") {
                if (cssColor[0] == "#") {
                    cssColor = cssColor.substring(1);
                }
                if (cssColor.length == 3) {
                    x = parseInt(cssColor[0], 16);
                    blue = x << 8 + x;
                    x = parseInt(cssColor[1], 16);
                    green = x << 8 + x;
                    x = parseInt(cssColor[2], 16);
                    red = x << 8 + x;
                } else {
                    blue = parseInt(cssColor.substring(0, 2), 16);
                    green = parseInt(cssColor.substring(2, 4), 16);
                    red = parseInt(cssColor.substring(4, 6), 16);
                }
            } else {
                blue = (cssColor & 0xff0000) >> 16;
                green = (cssColor & 0x00ff00) >> 8;
                red = (cssColor & 0x0000ff);
            }
            return [red, green, blue];
        };
        var num_to_hex2 = function(v) {
            var s = v.toString(16);
            if (s.length == 2) {
                return s;
            }
            return "0" + s;
        };
        var bgr_to_desaturated_rgb_for_css = function(bgrColor) {
            var [red, green, blue] = bgr_string_to_rgb_array(bgrColor);
            // And now reduce the saturation.
            const [H, S, V] = color.rgb2hsv(red, green, blue);
            // Reduce the intensity of the color by 30%
            const S1 = S * 0.7;
            const [R2, G2, B2] = color.hsv2rgb(H, S1, V);
            return "#" + num_to_hex2(R2) + num_to_hex2(G2) + num_to_hex2(B2);
        };
        try {
            insertColor = this._fix_rgb_color(this.view.scheme.getColor("changeMarginInserted"));
        } catch(ex) {
            log.exception(ex, "couldn't get the insert-color");
            insertColor = 0xa3dca6; // BGR for a muted green
        }
        try {
            deleteColor = this._fix_rgb_color(this.view.scheme.getColor("changeMarginDeleted"));
        } catch(ex) {
            log.exception(ex, "couldn't get the delete-color");
            deleteColor = 0x5457e7; // BGR for a muted red
        }
        try {
            replaceColor = this._fix_rgb_color(this.view.scheme.getColor("changeMarginReplaced"));
        } catch(e) {
            log.exception(ex, "couldn't get the change-color");
            replaceColor = 0xe8d362; // BGR for a muted blue
        }
        try {
            this.insertRGBColor = bgr_to_desaturated_rgb_for_css(insertColor);
            this.deleteRGBColor = bgr_to_desaturated_rgb_for_css(deleteColor);
            this.replaceRGBColor = bgr_to_desaturated_rgb_for_css(replaceColor);
        } catch(e) {
            log.exception(e, "Failed to convert a color from bgr to rgb");
        }

        /* Don't use 0 as a style number. marginGetStyles and marginSetStyles
        uses byte-strings of concatenated style numbers, but the implementation
        can't handle null bytes */
        this.clearStyleNum = 1;

        const defaultBackColor = scimoz.styleGetBack(scimoz.STYLE_LINENUMBER);
        scimoz.styleSetBack(this.clearStyleNum + styleOffset, defaultBackColor);
        scimoz.styleSetSize(this.clearStyleNum + styleOffset, marginCharacterSize);

        const insertStyleNum = this.clearStyleNum + 1;
        const insertBackColor = insertColor;
        scimoz.styleSetBack(insertStyleNum + styleOffset, insertBackColor);
        scimoz.styleSetSize(insertStyleNum + styleOffset, marginCharacterSize);

        const deleteStyleNum = this.clearStyleNum + 2;
        const deleteBackColor = deleteColor;
        scimoz.styleSetBack(deleteStyleNum + styleOffset, deleteBackColor);
        scimoz.styleSetSize(deleteStyleNum + styleOffset, marginCharacterSize);

        const replaceStyleNum = this.clearStyleNum + 3;
        const replaceBackColor = replaceColor;
        scimoz.styleSetBack(replaceStyleNum + styleOffset, replaceBackColor);
        scimoz.styleSetSize(replaceStyleNum + styleOffset, marginCharacterSize);

        // Create string variants, as the marginSetText takes a string.
        this.clearStyleString = String.fromCharCode(this.clearStyleNum);
        this.insertStyleString = String.fromCharCode(insertStyleNum);
        this.deleteStyleString = String.fromCharCode(deleteStyleNum);
        this.replaceStyleString = String.fromCharCode(replaceStyleNum);
    },

    _initMargins: function() {
        var scimoz = this.view.scimoz;
        scimoz.setMarginTypeN(MARGIN_CHANGEMARGIN,
                              scimoz.SC_MARGIN_RTEXT); // right-justified text
        this.marginWidth = scimoz.textWidth(this.clearStyleNum, " "); // 1 space
        // Note: If we try to set the margin Width to a smaller value,
        // Scintilla will display the rest of the space in the previous margin,
        // and clicking on that will trigger the previous margin's handler
        scimoz.setMarginWidthN(MARGIN_CHANGEMARGIN, this.marginWidth);
        scimoz.setMarginSensitiveN(MARGIN_CHANGEMARGIN, true);
    },

    _isMarkerSetOnLine: function(scimoz, styleString, lineNo) {
        var resultObj = {};
        scimoz.marginGetStyles(lineNo, resultObj);
        if (resultObj.value != styleString) {
            return false;
        }
        return true;
    },

    _specificMarkerSet: function(line, styleString, scimoz) {
        if (!scimoz) {
            scimoz = this.view.scimoz;
        }
        scimoz.marginSetText(line, " ");
        scimoz.marginSetStyles(line, styleString);
    },


    /**
     * Margin API.
     */

    close: function() {
        this.view = null;
    },

    showMargin: function() {
        this.view.scimoz.setMarginWidthN(MARGIN_CHANGEMARGIN, this.marginWidth);
    },

    hideMargin: function() {
        this.view.scimoz.setMarginWidthN(MARGIN_CHANGEMARGIN, 0);
    },

    refreshMarginProperies: function refreshMarginProperies() {
        this._initMarkerStyles(10); // maximum is 128
        this._initMargins();
    },

    clear: function() {
        // We can't use the held deletion/insertion lists because the line numbers
        // could have changed.
        const scimoz = this.view.scimoz;
        const lim = scimoz.lineCount;
        for (let lineNo = 0; lineNo < lim; lineNo++) {
            scimoz.marginSetStyles(lineNo, this.clearStyleString);
        }
        this.previous_deletions = new Set();
        this.previous_insertions = new Set();
        this.previous_replacements = new Set();
    },

    clearLineNos: function(lineNos, styleString) {
        // We can't use the held deletion/insertion lists because the line numbers
        // could have changed.
        const scimoz = this.view.scimoz;
        for (let lineNo of lineNos) {
            if (!this._isMarkerSetOnLine(scimoz, styleString, lineNo)) {
                return CACHE_OUT_OF_DATE;
            }
            scimoz.marginSetStyles(lineNo, this.clearStyleString);
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
        if (this.clearLineNos(expired_deletions, this.deleteStyleString) == CACHE_OUT_OF_DATE ||
            this.clearLineNos(expired_insertions, this.insertStyleString) == CACHE_OUT_OF_DATE ||
            this.clearLineNos(expired_replacements, this.replaceStyleString) == CACHE_OUT_OF_DATE)
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
                return !margin._isMarkerSetOnLine(scimoz, margin.deleteStyleString, lineNo);
            }) ||
            unchanged_insertions.some(function(lineNo) {
                return !margin._isMarkerSetOnLine(scimoz, margin.insertStyleString, lineNo);
            }) ||
            unchanged_replacements.some(function(lineNo) {
                return !margin._isMarkerSetOnLine(scimoz, margin.replaceStyleString, lineNo);
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
            margin._specificMarkerSet(lineNo, margin.deleteStyleString, scimoz);
        });
        // Add the new insertion positions.
        new_insertions.forEach(function(lineNo) {
            margin._specificMarkerSet(lineNo, margin.insertStyleString, scimoz);
        });
        // Add the new replacement positions.
        new_replacements.forEach(function(lineNo) {
            margin._specificMarkerSet(lineNo, margin.replaceStyleString, scimoz);
        });

        // And store them for the next time.
        this.previous_deletions = deletions;
        this.previous_insertions = insertions;
        this.previous_replacements = replacements;
    },

    __EOF__: null
};

