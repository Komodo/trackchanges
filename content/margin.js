/**
 * Margin - manages the scintilla margin to show file changes.
 */

const { Ci } = require("chrome");
const color = require("ko/color");

const MARGIN_TEXT_LENGTH = 1;
// TODO: Move const for margin number to core editor file.
const MARGIN_CHANGEMARGIN = 3;

const CHANGES_NONE = Ci.koIDocument.CHANGES_NONE;
const CHANGES_INSERT = Ci.koIDocument.CHANGES_INSERT;
const CHANGES_DELETE = Ci.koIDocument.CHANGES_DELETE;
const CHANGES_REPLACE = Ci.koIDocument.CHANGES_REPLACE;

var log = require("ko/logging").getLogger("CT::margin.js");
//log.setLevel(ko.logging.LOG_INFO);

exports.MarginController = function MarginController(view) {
    this.view = view;
    // Remember the margin change positions.
    this.previous_deletions = new Set();
    this.previous_insertions = new Set();
    this.previous_modifications = new Set();
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
        this.clearStyle = String.fromCharCode(this.clearStyleNum);

        const defaultBackColor = scimoz.styleGetBack(scimoz.STYLE_LINENUMBER);
        scimoz.styleSetBack(this.clearStyleNum + styleOffset, defaultBackColor);
        scimoz.styleSetSize(this.clearStyleNum + styleOffset, marginCharacterSize);

        this.insertStyleNum = this.clearStyleNum + 1;
        const insertBackColor = insertColor;
        scimoz.styleSetBack(this.insertStyleNum + styleOffset, insertBackColor);
        scimoz.styleSetSize(this.insertStyleNum + styleOffset, marginCharacterSize);

        this.deleteStyleNum = this.clearStyleNum + 2;
        const deleteBackColor = deleteColor;
        scimoz.styleSetBack(this.deleteStyleNum + styleOffset, deleteBackColor);
        scimoz.styleSetSize(this.deleteStyleNum + styleOffset, marginCharacterSize);

        this.replaceStyleNum = this.clearStyleNum + 3;
        const replaceBackColor = replaceColor;
        scimoz.styleSetBack(this.replaceStyleNum + styleOffset, replaceBackColor);
        scimoz.styleSetSize(this.replaceStyleNum + styleOffset, marginCharacterSize);
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

    _specificMarkerSet: function(line, styleNum, scimoz) {
        if (!scimoz) {
            scimoz = this.view.scimoz;
        }
        scimoz.marginSetText(line, " ");
        scimoz.marginSetStyles(line, String.fromCharCode(styleNum));
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
            scimoz.marginSetStyles(lineNo, this.clearStyle);
        }
        this.previous_deletions = new Set();
        this.previous_insertions = new Set();
        this.previous_modifications = new Set();
    },

    clearLineNos: function(lineNos) {
        // We can't use the held deletion/insertion lists because the line numbers
        // could have changed.
        const scimoz = this.view.scimoz;
        for (let lineNo of lineNos) {
            scimoz.marginSetStyles(lineNo, this.clearStyle);
        }
    },

    activeMarkerMask: function(lineNo) {
        if (this.previous_deletions.has(lineNo))
            return 1 << CHANGES_DELETE;
        if (this.previous_insertions.has(lineNo))
            return 1 << CHANGES_INSERT;
        if (this.previous_modifications.has(lineNo))
            return 1 << CHANGES_REPLACE;
        return 0;
    },

    markChanges: function(deletions, insertion_ranges, modification_ranges) {
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

        // Turn into sets of line numbers.
        deletions = new Set(deletions);
        var insertions = new Set(linesFromLineRange(insertion_ranges));
        var modifications = new Set(linesFromLineRange(modification_ranges));

        // Determine old margin entries that need removal.
        var expired_deletions = [x for (x of this.previous_deletions) if (!(deletions.has(x)))];
        var expired_insertions = [x for (x of this.previous_insertions) if (!(insertions.has(x)))];
        var expired_modifications = [x for (x of this.previous_modifications) if (!(modifications.has(x)))];
        this.clearLineNos(expired_deletions);
        this.clearLineNos(expired_insertions);
        this.clearLineNos(expired_modifications);

        // Determine new modification positions, that don't already exist.
        var new_deletions = [x for (x of deletions) if (!(this.previous_deletions.has(x)))];
        var new_insertions = [x for (x of insertions) if (!(this.previous_insertions.has(x)))];
        var new_modifications = [x for (x of modifications) if (!(this.previous_modifications.has(x)))];

        const scimoz = this.view.scimoz;
        var margin = this;

        // Add the new deletion positions.
        new_deletions.forEach(function(lineNo) {
            margin._specificMarkerSet(lineNo, margin.deleteStyleNum, scimoz);
        });
        // Add the new insertion positions.
        new_insertions.forEach(function(lineNo) {
            margin._specificMarkerSet(lineNo, margin.insertStyleNum, scimoz);
        });
        // Add the new modification positions.
        new_modifications.forEach(function(lineNo) {
            margin._specificMarkerSet(lineNo, margin.replaceStyleNum, scimoz);
        });

        // And store them for the next time.
        this.previous_deletions = deletions;
        this.previous_insertions = insertions;
        this.previous_modifications = modifications;
    },

    __EOF__: null
};

