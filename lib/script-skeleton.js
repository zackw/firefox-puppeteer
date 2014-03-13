// Firefox Puppeteer: control script skeleton.
// Copyright 2014 Zack Weinberg.
// Somewhat based on MozRepl by Ethan, Étienne Deparis, Ian Shannon,
// Luca Greco, Massimiliano Mirra, and others.
// GPLv3+ - see COPYING at top level.

// There is no way to tell the SDK's script loader "load this
// JavaScript as if it were a new module".  We have to kludge it.
// Part of the kludge is this module, whose sole function is to dump
// all of the globals provided to a module into its own exports,
// allowing us to create sandboxes that mimic the loader's sandboxes.

'use strict';

// When used by control scripts, require() will permit access as if it
// is being called from this module, so we must arrange to have
// everything that a control script would reasonably want considered a
// requirement of this module.  This seems to be the de facto
// technique for doing that.  Note that all modules for adding stuff
// to the browser UI have been deliberately excluded from the list
// below, as have chrome and xpcom; but I will cheerfully add anything
// that someone provides me with a use case for.  Note also that this
// list was derived from MDN, not the SDK source, and so may not be
// exhaustive.

/*
require("sdk/loader/sandbox"); // actually for the code here

require("sdk/base64");
require("sdk/clipboard");
require("sdk/indexed-db");
require("sdk/page-mod");
require("sdk/page-worker");
require("sdk/passwords");
require("sdk/private-browsing");
require("sdk/querystring");
require("sdk/request");
require("sdk/selection");
require("sdk/self");
require("sdk/simple-prefs");
require("sdk/simple-storage");
require("sdk/system");
require("sdk/tabs");
require("sdk/timers");
require("sdk/url");
require("sdk/windows");

require("sdk/content/mod");
require("sdk/core/heritage");
require("sdk/core/namespace");
require("sdk/core/promise");
require("sdk/event/core");
require("sdk/event/target");
require("sdk/io/byte-streams");
require("sdk/io/file");
require("sdk/io/text-streams");
require("sdk/lang/functional");
require("sdk/lang/type");
require("sdk/net/url");
require("sdk/net/xhr");
require("sdk/places/bookmarks");
require("sdk/places/favicon");
require("sdk/places/history");
require("sdk/preferences/service");
require("sdk/stylesheet/style");
require("sdk/stylesheet/utils");
require("sdk/system/events");
require("sdk/system/runtime");
require("sdk/system/unload");
require("sdk/system/xul-app");
require("sdk/tabs/utils");
require("sdk/util/array");
require("sdk/util/collection");
require("sdk/util/list");
require("sdk/util/match-pattern");
require("sdk/util/object");
require("sdk/util/uuid");
require("sdk/window/utils");
*/

// The code actually _in_ this module is structured to not leave any
// global definitions behind.
(function (global) {
    const sandbox = require("sdk/loader/sandbox");
    function extract (gl, blacklist) {
        let globals = {};
        for (let obj = gl; obj !== null; obj = Object.getPrototypeOf(obj)) {
            for (let key of Object.getOwnPropertyNames(obj)) {
                // I don't understand why, but writing
                // "blacklist.hasOwnProperty(key)" here crashes.
                if (!Object.hasOwnProperty.call(blacklist, key)) {
                    globals[key] = obj[key];
                }
            }
        }
        return globals;
    }

    // Things that we know a priori we don't want to reflect.
    let blacklist = { Components: true,
                      module: true,
                      exports: true }

    // We also don't need to reflect anything that is in a regular old
    // sandbox by default.
    let bareSandbox = sandbox.sandbox(null, {
        sandboxName: "bare sandbox for default property extraction",
        sandboxPrototype: { extract: extract },
        wantComponents: false
    });
    let bsContents = sandbox.evaluate(bareSandbox,
                                       "extract(this, {extract: 1})");
    for (let k of Object.getOwnPropertyNames(bsContents))
        blacklist[k] = true;

    let toExport = extract(global, blacklist);
    for (let k of Object.getOwnPropertyNames(toExport))
        global.exports[k] = toExport[k]
})(this);
