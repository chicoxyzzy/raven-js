/*global XDomainRequest:false*/
'use strict';

var TraceKit = require('../vendor/TraceKit/tracekit');
var consolePlugin = require('../plugins/console');
var RavenConfigError = require('./configError');
var utils = require('./utils');

var isFunction = utils.isFunction;
var isUndefined = utils.isUndefined;
var isError = utils.isError;
var isEmptyObject = utils.isEmptyObject;
var hasKey = utils.hasKey;
var joinRegExp = utils.joinRegExp;
var each = utils.each;
var objectMerge = utils.objectMerge;
var truncate = utils.truncate;
var urlencode = utils.urlencode;
var uuid4 = utils.uuid4;
var htmlElementAsString = utils.htmlElementAsString;

var dsnKeys = 'source protocol user pass host port path'.split(' '),
    dsnPattern = /^(?:(\w+):)?\/\/(?:(\w+)(:\w+)?@)?([\w\.-]+)(?::(\d+))?(\/.*)/;

function now() {
    return +new Date();
}

// First, check for JSON support
// If there is no JSON, we no-op the core features of Raven
// since JSON is required to encode the payload
function Raven() {
    this._hasJSON = !!(typeof JSON === 'object' && JSON.stringify);
    // Raven can run in contexts where there's no document (react-native)
    this._hasDocument = typeof document !== 'undefined';
    this._lastCapturedException = null;
    this._lastEventId = null;
    this._globalServer = null;
    this._globalKey = null;
    this._globalProject = null;
    this._globalContext = {};
    this._globalOptions = {
        logger: 'javascript',
        ignoreErrors: [],
        ignoreUrls: [],
        whitelistUrls: [],
        includePaths: [],
        crossOrigin: 'anonymous',
        collectWindowErrors: true,
        maxMessageLength: 0,
        stackTraceLimit: 50
    };
    this._ignoreOnError = 0;
    this._isRavenInstalled = false;
    this._originalErrorStackTraceLimit = Error.stackTraceLimit;
    // capture references to window.console *and* all its methods first
    // before the console plugin has a chance to monkey patch
    this._originalConsole = window.console || {};
    this._originalConsoleMethods = {};
    this._plugins = [];
    this._startTime = now();
    this._wrappedBuiltIns = [];
    this._breadcrumbs = [];
    this._breadcrumbLimit = 20;
    this._lastCapturedEvent = null;
    this._lastHref = window.location && location.href;

    for (var method in this._originalConsole) {  // eslint-disable-line guard-for-in
      this._originalConsoleMethods[method] = this._originalConsole[method];
    }
}

/*
 * The core Raven singleton
 *
 * @this {Raven}
 */

Raven.prototype = {
    // Hardcode version string so that raven source can be loaded directly via
    // webpack (using a build step causes webpack #1617). Grunt verifies that
    // this value matches package.json during build.
    //   See: https://github.com/getsentry/raven-js/issues/465
    VERSION: '2.3.0',

    debug: false,

    TraceKit: TraceKit, // alias to TraceKit

    /*
     * Configure Raven with a DSN and extra options
     *
     * @param {string} dsn The public Sentry DSN
     * @param {object} options Optional set of of global options [optional]
     * @return {Raven}
     */
    config: function(dsn, options) {
        var self = this;

        if (this._globalServer) {
                this._logDebug('error', 'Error: Raven has already been configured');
            return this;
        }
        if (!dsn) return this;

        // merge in options
        if (options) {
            each(options, function(key, value){
                // tags and extra are special and need to be put into context
                if (key === 'tags' || key === 'extra') {
                    self._globalContext[key] = value;
                } else {
                    self._globalOptions[key] = value;
                }
            });
        }

        var uri = this._parseDSN(dsn),
            lastSlash = uri.path.lastIndexOf('/'),
            path = uri.path.substr(1, lastSlash);

        this._dsn = dsn;

        // "Script error." is hard coded into browsers for errors that it can't read.
        // this is the result of a script being pulled in from an external domain and CORS.
        this._globalOptions.ignoreErrors.push(/^Script error\.?$/);
        this._globalOptions.ignoreErrors.push(/^Javascript error: Script error\.? on line 0$/);

        // join regexp rules into one big rule
        this._globalOptions.ignoreErrors = joinRegExp(this._globalOptions.ignoreErrors);
        this._globalOptions.ignoreUrls = this._globalOptions.ignoreUrls.length ? joinRegExp(this._globalOptions.ignoreUrls) : false;
        this._globalOptions.whitelistUrls = this._globalOptions.whitelistUrls.length ? joinRegExp(this._globalOptions.whitelistUrls) : false;
        this._globalOptions.includePaths = joinRegExp(this._globalOptions.includePaths);

        this._globalKey = uri.user;
        this._globalSecret = uri.pass && uri.pass.substr(1);
        this._globalProject = uri.path.substr(lastSlash + 1);

        this._globalServer = this._getGlobalServer(uri);

        this._globalEndpoint = this._globalServer +
            '/' + path + 'api/' + this._globalProject + '/store/';

        if (this._globalOptions.fetchContext) {
            TraceKit.remoteFetching = true;
        }

        if (this._globalOptions.linesOfContext) {
            TraceKit.linesOfContext = this._globalOptions.linesOfContext;
        }

        TraceKit.collectWindowErrors = !!this._globalOptions.collectWindowErrors;

        // return for chaining
        return this;
    },

    /*
     * Installs a global window.onerror error handler
     * to capture and report uncaught exceptions.
     * At this point, install() is required to be called due
     * to the way TraceKit is set up.
     *
     * @return {Raven}
     */
    install: function() {
        var self = this;
        if (this.isSetup() && !this._isRavenInstalled) {
            TraceKit.report.subscribe(function () {
                self._handleOnErrorStackInfo.apply(self, arguments);
            });
            this._wrapBuiltIns();

            // Install all of the plugins
            this._drainPlugins();

            this._isRavenInstalled = true;
        }

        Error.stackTraceLimit = this._globalOptions.stackTraceLimit;
        return this;
    },

    /*
     * Wrap code within a context so Raven can capture errors
     * reliably across domains that is executed immediately.
     *
     * @param {object} options A specific set of options for this context [optional]
     * @param {function} func The callback to be immediately executed within the context
     * @param {array} args An array of arguments to be called with the callback [optional]
     */
    context: function(options, func, args) {
        if (isFunction(options)) {
            args = func || [];
            func = options;
            options = undefined;
        }

        return this.wrap(options, func).apply(this, args);
    },

    /*
     * Wrap code within a context and returns back a new function to be executed
     *
     * @param {object} options A specific set of options for this context [optional]
     * @param {function} func The function to be wrapped in a new context
     * @param {function} func A function to call before the try/catch wrapper [optional, private]
     * @return {function} The newly wrapped functions with a context
     */
    wrap: function(options, func, _before) {
        var self = this;
        // 1 argument has been passed, and it's not a function
        // so just return it
        if (isUndefined(func) && !isFunction(options)) {
            return options;
        }

        // options is optional
        if (isFunction(options)) {
            func = options;
            options = undefined;
        }

        // At this point, we've passed along 2 arguments, and the second one
        // is not a function either, so we'll just return the second argument.
        if (!isFunction(func)) {
            return func;
        }

        // We don't wanna wrap it twice!
        try {
            if (func.__raven__) {
                return func;
            }
        } catch (e) {
            // Just accessing the __raven__ prop in some Selenium environments
            // can cause a "Permission denied" exception (see raven-js#495).
            // Bail on wrapping and return the function as-is (defers to window.onerror).
            return func;
        }

        // If this has already been wrapped in the past, return that
        if (func.__raven_wrapper__ ){
            return func.__raven_wrapper__ ;
        }

        function wrapped() {
            var args = [], i = arguments.length,
                deep = !options || options && options.deep !== false;

            if (_before && isFunction(_before)) {
                _before.apply(this, arguments);
            }

            // Recursively wrap all of a function's arguments that are
            // functions themselves.
            while(i--) args[i] = deep ? self.wrap(options, arguments[i]) : arguments[i];

            try {
                return func.apply(this, args);
            } catch(e) {
                self._ignoreNextOnError();
                self.captureException(e, options);
                throw e;
            }
        }

        // copy over properties of the old function
        for (var property in func) {
            if (hasKey(func, property)) {
                wrapped[property] = func[property];
            }
        }
        wrapped.prototype = func.prototype;

        func.__raven_wrapper__ = wrapped;
        // Signal that this function has been wrapped already
        // for both debugging and to prevent it to being wrapped twice
        wrapped.__raven__ = true;
        wrapped.__inner__ = func;

        return wrapped;
    },

    /*
     * Uninstalls the global error handler.
     *
     * @return {Raven}
     */
    uninstall: function() {
        TraceKit.report.uninstall();

        this._restoreBuiltIns();

        Error.stackTraceLimit = this._originalErrorStackTraceLimit;
        this._isRavenInstalled = false;

        return this;
    },

    /*
     * Manually capture an exception and send it over to Sentry
     *
     * @param {error} ex An exception to be logged
     * @param {object} options A specific set of options for this error [optional]
     * @return {Raven}
     */
    captureException: function(ex, options) {
        // If not an Error is passed through, recall as a message instead
        if (!isError(ex)) return this.captureMessage(ex, options);

        // Store the raw exception object for potential debugging and introspection
        this._lastCapturedException = ex;

        // TraceKit.report will re-raise any exception passed to it,
        // which means you have to wrap it in try/catch. Instead, we
        // can wrap it here and only re-raise if TraceKit.report
        // raises an exception different from the one we asked to
        // report on.
        try {
            var stack = TraceKit.computeStackTrace(ex);
            this._handleStackInfo(stack, options);
        } catch(ex1) {
            if(ex !== ex1) {
                throw ex1;
            }
        }

        return this;
    },

    /*
     * Manually send a message to Sentry
     *
     * @param {string} msg A plain message to be captured in Sentry
     * @param {object} options A specific set of options for this message [optional]
     * @return {Raven}
     */
    captureMessage: function(msg, options) {
        // config() automagically converts ignoreErrors from a list to a RegExp so we need to test for an
        // early call; we'll error on the side of logging anything called before configuration since it's
        // probably something you should see:
        if (!!this._globalOptions.ignoreErrors.test && this._globalOptions.ignoreErrors.test(msg)) {
            return;
        }

        // Fire away!
        this._send(
            objectMerge({
                message: msg + ''  // Make sure it's actually a string
            }, options)
        );

        return this;
    },

    captureBreadcrumb: function (type, data) {
        var crumb = {
            type: type,
            timestamp: now() / 1000,
            data: data
        };

        this._breadcrumbs.push(crumb);
        if (this._breadcrumbs.length > this._breadcrumbLimit) {
            this._breadcrumbs.shift();
        }
    },

    addPlugin: function(plugin /*arg1, arg2, ... argN*/) {
        var pluginArgs = Array.prototype.slice.call(arguments, 1);

        this._plugins.push([plugin, pluginArgs]);
        if (this._isRavenInstalled) {
            this._drainPlugins();
        }

        return this;
    },

    /*
     * Set/clear a user to be sent along with the payload.
     *
     * @param {object} user An object representing user data [optional]
     * @return {Raven}
     */
    setUserContext: function(user) {
        // Intentionally do not merge here since that's an unexpected behavior.
        this._globalContext.user = user;

        return this;
    },

    /*
     * Merge extra attributes to be sent along with the payload.
     *
     * @param {object} extra An object representing extra data [optional]
     * @return {Raven}
     */
    setExtraContext: function(extra) {
        this._mergeContext('extra', extra);

        return this;
    },

    /*
     * Merge tags to be sent along with the payload.
     *
     * @param {object} tags An object representing tags [optional]
     * @return {Raven}
     */
    setTagsContext: function(tags) {
        this._mergeContext('tags', tags);

        return this;
    },

    /*
     * Clear all of the context.
     *
     * @return {Raven}
     */
    clearContext: function() {
        this._globalContext = {};

        return this;
    },

    /*
     * Get a copy of the current context. This cannot be mutated.
     *
     * @return {object} copy of context
     */
    getContext: function() {
        // lol javascript
        return JSON.parse(JSON.stringify(this._globalContext));
    },

    /*
     * Set release version of application
     *
     * @param {string} release Typically something like a git SHA to identify version
     * @return {Raven}
     */
    setRelease: function(release) {
        this._globalOptions.release = release;

        return this;
    },

    /*
     * Set the dataCallback option
     *
     * @param {function} callback The callback to run which allows the
     *                            data blob to be mutated before sending
     * @return {Raven}
     */
    setDataCallback: function(callback) {
        this._globalOptions.dataCallback = callback;

        return this;
    },

    /*
     * Set the shouldSendCallback option
     *
     * @param {function} callback The callback to run which allows
     *                            introspecting the blob before sending
     * @return {Raven}
     */
    setShouldSendCallback: function(callback) {
        this._globalOptions.shouldSendCallback = callback;

        return this;
    },

    /**
     * Override the default HTTP transport mechanism that transmits data
     * to the Sentry server.
     *
     * @param {function} transport Function invoked instead of the default
     *                             `makeRequest` handler.
     *
     * @return {Raven}
     */
    setTransport: function(transport) {
        this._globalOptions.transport = transport;

        return this;
    },

    /*
     * Get the latest raw exception that was captured by Raven.
     *
     * @return {error}
     */
    lastException: function() {
        return this._lastCapturedException;
    },

    /*
     * Get the last event id
     *
     * @return {string}
     */
    lastEventId: function() {
        return this._lastEventId;
    },

    /*
     * Determine if Raven is setup and ready to go.
     *
     * @return {boolean}
     */
    isSetup: function() {
        if (!this._hasJSON) return false;  // needs JSON support
        if (!this._globalServer) {
            if (!this.ravenNotConfiguredError) {
              this.ravenNotConfiguredError = true;
              this._logDebug('error', 'Error: Raven has not been configured.');
            }
            return false;
        }
        return true;
    },

    afterLoad: function () {
        // TODO: remove window dependence?

        // Attempt to initialize Raven on load
        var RavenConfig = window.RavenConfig;
        if (RavenConfig) {
            this.config(RavenConfig.dsn, RavenConfig.config).install();
        }
    },

    showReportDialog: function (options) {
        if (!window.document) // doesn't work without a document (React native)
            return;

        options = options || {};

        var lastEventId = options.eventId || this.lastEventId();
        if (!lastEventId) {
            throw new RavenConfigError('Missing eventId');
        }

        var dsn = options.dsn || this._dsn;
        if (!dsn) {
            throw new RavenConfigError('Missing DSN');
        }

        var encode = encodeURIComponent;
        var qs = '';
        qs += '?eventId=' + encode(lastEventId);
        qs += '&dsn=' + encode(dsn);

        var user = options.user || this._globalContext.user;
        if (user) {
            if (user.name)  qs += '&name=' + encode(user.name);
            if (user.email) qs += '&email=' + encode(user.email);
        }

        var globalServer = this._getGlobalServer(this._parseDSN(dsn));

        var script = document.createElement('script');
        script.async = true;
        script.src = globalServer + '/api/embed/error-page/' + qs;
        (document.head || document.body).appendChild(script);
    },

    /**** Private functions ****/
    _ignoreNextOnError: function () {
        var self = this;
        this._ignoreOnError += 1;
        setTimeout(function () {
            // onerror should trigger before setTimeout
            self._ignoreOnError -= 1;
        });
    },

    _triggerEvent: function(eventType, options) {
        // NOTE: `event` is a native browser thing, so let's avoid conflicting wiht it
        var evt, key;

        if (!this._hasDocument)
            return;

        options = options || {};

        eventType = 'raven' + eventType.substr(0,1).toUpperCase() + eventType.substr(1);

        if (document.createEvent) {
            evt = document.createEvent('HTMLEvents');
            evt.initEvent(eventType, true, true);
        } else {
            evt = document.createEventObject();
            evt.eventType = eventType;
        }

        for (key in options) if (hasKey(options, key)) {
            evt[key] = options[key];
        }

        if (document.createEvent) {
            // IE9 if standards
            document.dispatchEvent(evt);
        } else {
            // IE8 regardless of Quirks or Standards
            // IE9 if quirks
            try {
                document.fireEvent('on' + evt.eventType.toLowerCase(), evt);
            } catch(e) {
                // Do nothing
            }
        }
    },


    /**
     * Wraps addEventListener to capture UI breadcrumbs
     * @param evtName the event name (e.g. "click")
     * @param fn the function being wrapped
     * @returns {Function}
     * @private
     */
    _breadcrumbEventHandler: function(evtName) {
        var self = this;
        return function (evt) {
            // It's possible this handler might trigger multiple times for the same
            // event (e.g. event propagation through node ancestors). Ignore if we've
            // already captured the event.
            if (self._lastCapturedEvent === evt)
                return;

            self._lastCapturedEvent = evt;
            var elem = evt.target;
            self.captureBreadcrumb('ui_event', {
                type: evtName,
                target: htmlElementAsString(elem)
            });
        };
    },

    /**
     * Install any queued plugins
     */
    _wrapBuiltIns: function() {
        var self = this;

        function fill(obj, name, replacement, noUndo) {
            var orig = obj[name];
            obj[name] = replacement(orig);
            if (!noUndo) {
                self._wrappedBuiltIns.push([obj, name, orig]);
            }
        }

        function wrapTimeFn(orig) {
            return function (fn, t) { // preserve arity
                // Make a copy of the arguments
                var args = [].slice.call(arguments);
                var originalCallback = args[0];
                if (isFunction(originalCallback)) {
                    args[0] = self.wrap(originalCallback);
                }

                // IE < 9 doesn't support .call/.apply on setInterval/setTimeout, but it
                // also supports only two arguments and doesn't care what this is, so we
                // can just call the original function directly.
                if (orig.apply) {
                    return orig.apply(this, args);
                } else {
                    return orig(args[0], args[1]);
                }
            };
        }

        fill(window, 'setTimeout', wrapTimeFn);
        fill(window, 'setInterval', wrapTimeFn);
        if (window.requestAnimationFrame) {
            fill(window, 'requestAnimationFrame', function (orig) {
                return function (cb) {
                    return orig(self.wrap(cb));
                };
            });
        }

        // Capture breadcrubms from any click that is unhandled / bubbled up all the way
        // to the document. Do this before we instrument addEventListener.
        if (this._hasDocument) {
            document.addEventListener('click', self._breadcrumbEventHandler('click'));

        }

        // event targets borrowed from bugsnag-js:
        // https://github.com/bugsnag/bugsnag-js/blob/master/src/bugsnag.js#L666
        'EventTarget Window Node ApplicationCache AudioTrackList ChannelMergerNode CryptoOperation EventSource FileReader HTMLUnknownElement IDBDatabase IDBRequest IDBTransaction KeyOperation MediaController MessagePort ModalWindow Notification SVGElementInstance Screen TextTrack TextTrackCue TextTrackList WebSocket WebSocketWorker Worker XMLHttpRequest XMLHttpRequestEventTarget XMLHttpRequestUpload'.replace(/\w+/g, function (global) {
            var proto = window[global] && window[global].prototype;
            if (proto && proto.hasOwnProperty && proto.hasOwnProperty('addEventListener')) {
                fill(proto, 'addEventListener', function(orig) {
                    return function (evt, fn, capture, secure) { // preserve arity
                        try {
                            if (fn && fn.handleEvent) {
                                fn.handleEvent = self.wrap(fn.handleEvent);
                            }
                        } catch (err) {
                            // can sometimes get 'Permission denied to access property "handle Event'
                        }


                        // TODO: more than just click
                        var before;
                        if ((global === 'EventTarget' || global === 'Node') && evt === 'click') {
                            before = self._breadcrumbEventHandler(evt, fn);
                        }
                        return orig.call(this, evt, self.wrap(fn, undefined, before), capture, secure);
                    };
                });
                fill(proto, 'removeEventListener', function (orig) {
                    return function (evt, fn, capture, secure) {
                        fn = fn && (fn.__raven_wrapper__ ? fn.__raven_wrapper__  : fn);
                        return orig.call(this, evt, fn, capture, secure);
                    };
                });
            }
        });

        if ('XMLHttpRequest' in window) {
            var xhrproto = XMLHttpRequest.prototype;
            fill(xhrproto, 'open', function(origOpen) {
                return function (method, url) { // preserve arity
                    this.__raven_xhr = {
                        method: method,
                        url: url,
                        statusCode: null
                    };
                    return origOpen.apply(this, arguments);
                };
            });

            fill(xhrproto, 'send', function(origSend) {
                return function (data) { // preserve arity
                    var xhr = this;
                    'onreadystatechange onload onerror onprogress'.replace(/\w+/g, function (prop) {
                        if (prop in xhr && isFunction(xhr[prop])) {
                            fill(xhr, prop, function (orig) {
                                if (prop === 'onreadystatechange' && xhr.__raven_xhr && (xhr.readyState === 1 || xhr.readyState === 4)) {
                                    try {
                                        // touching statusCode in some platforms throws
                                        // an exception
                                        xhr.__raven_xhr.statusCode = xhr.status;
                                    } catch (e) { /* do nothing */ }
                                    self.captureBreadcrumb('http_request', xhr.__raven_xhr);
                                }
                                return self.wrap(orig);
                            }, true /* noUndo */); // don't track filled methods on XHR instances
                        }
                    });
                    return origSend.apply(this, arguments);
                };
            });
        }

        // record navigation (URL) changes
        if ('history' in window && history.pushState) {
            // TODO: remove onpopstate handler on uninstall()
            var oldOnPopState = window.onpopstate;
            window.onpopstate = function () {
                self.captureBreadcrumb('navigation', {
                    from: self._lastHref,
                    to: location.href
                });

                // because onpopstate only tells you the "new" (to) value of location.href, and
                // not the previous (from) value, we need to track the value of location.href
                // ourselves
                self._lastHref = location.href;
                if (oldOnPopState) {
                    return oldOnPopState.apply(this, arguments);
                }
            };

            fill(history, 'pushState', function (origPushState) {
                // note history.pushState.length is 0; intentionally not declaring
                // params to preserve 0 arity
                return function(/* state, title, url */) {
                    var url = arguments.length > 2 ? arguments[2] : undefined;
                    self.captureBreadcrumb('navigation', {
                        to: url,
                        from: location.href
                    });
                    if (url) self._lastHref = url;
                    return origPushState.apply(this, arguments);
                }
            });
        }

        // console
        if ('console' in window && console.log) {
            consolePlugin(self, console, {
                levels: ['debug', 'info', 'warn', 'error', 'log'],
                callback: function (msg, data) {
                    self.captureBreadcrumb('message', {
                        level: data.level,
                        message: msg
                    });
                }
            });
        }

        var $ = window.jQuery || window.$;
        if ($ && $.fn && $.fn.ready) {
            fill($.fn, 'ready', function (orig) {
                return function (fn) {
                    return orig.call(this, self.wrap(fn));
                };
            });
        }
    },

    _restoreBuiltIns: function () {
        // restore any wrapped builtins
        var builtin;
        while (this._wrappedBuiltIns.length) {
            builtin = this._wrappedBuiltIns.shift();

            var obj = builtin[0],
              name = builtin[1],
              orig = builtin[2];

            obj[name] = orig;
        }
    },

    _drainPlugins: function() {
        var self = this;

        // FIX ME TODO
        each(this._plugins, function(_, plugin) {
            var installer = plugin[0];
            var args = plugin[1];
            installer.apply(self, [self].concat(args));
        });
    },

    _parseDSN: function(str) {
        var m = dsnPattern.exec(str),
            dsn = {},
            i = 7;

        try {
            while (i--) dsn[dsnKeys[i]] = m[i] || '';
        } catch(e) {
            throw new RavenConfigError('Invalid DSN: ' + str);
        }

        if (dsn.pass && !this._globalOptions.allowSecretKey) {
            throw new RavenConfigError('Do not specify your secret key in the DSN. See: http://bit.ly/raven-secret-key');
        }

        return dsn;
    },

    _getGlobalServer: function(uri) {
        // assemble the endpoint from the uri pieces
        var globalServer = '//' + uri.host +
            (uri.port ? ':' + uri.port : '');

        if (uri.protocol) {
            globalServer = uri.protocol + ':' + globalServer;
        }
        return globalServer;
    },

    _handleOnErrorStackInfo: function() {
        // if we are intentionally ignoring errors via onerror, bail out
        if (!this._ignoreOnError) {
            this._handleStackInfo.apply(this, arguments);
        }
    },

    _handleStackInfo: function(stackInfo, options) {
        var self = this;
        var frames = [];

        if (stackInfo.stack && stackInfo.stack.length) {
            each(stackInfo.stack, function(i, stack) {
                var frame = self._normalizeFrame(stack);
                if (frame) {
                    frames.push(frame);
                }
            });
        }

        this._triggerEvent('handle', {
            stackInfo: stackInfo,
            options: options
        });

        this._processException(
            stackInfo.name,
            stackInfo.message,
            stackInfo.url,
            stackInfo.lineno,
            frames.slice(0, this._globalOptions.stackTraceLimit),
            options
        );
    },

    _normalizeFrame: function(frame) {
        if (!frame.url) return;

        // normalize the frames data
        var normalized = {
            filename:   frame.url,
            lineno:     frame.line,
            colno:      frame.column,
            'function': frame.func || '?'
        }, context = this._extractContextFromFrame(frame), i;

        if (context) {
            var keys = ['pre_context', 'context_line', 'post_context'];
            i = 3;
            while (i--) normalized[keys[i]] = context[i];
        }

        normalized.in_app = !( // determine if an exception came from outside of our app
            // first we check the global includePaths list.
            !!this._globalOptions.includePaths.test && !this._globalOptions.includePaths.test(normalized.filename) ||
            // Now we check for fun, if the function name is Raven or TraceKit
            /(Raven|TraceKit)\./.test(normalized['function']) ||
            // finally, we do a last ditch effort and check for raven.min.js
            /raven\.(min\.)?js$/.test(normalized.filename)
        );

        return normalized;
    },

    _extractContextFromFrame: function(frame) {
        // immediately check if we should even attempt to parse a context
        if (!frame.context || !this._globalOptions.fetchContext) return;

        var context = frame.context,
            pivot = ~~(context.length / 2),
            i = context.length, isMinified = false;

        while (i--) {
            // We're making a guess to see if the source is minified or not.
            // To do that, we make the assumption if *any* of the lines passed
            // in are greater than 300 characters long, we bail.
            // Sentry will see that there isn't a context
            if (context[i].length > 300) {
                isMinified = true;
                break;
            }
        }

        if (isMinified) {
            // The source is minified and we don't know which column. Fuck it.
            if (isUndefined(frame.column)) return;

            // If the source is minified and has a frame column
            // we take a chunk of the offending line to hopefully shed some light
            return [
                [],  // no pre_context
                context[pivot].substr(frame.column, 50), // grab 50 characters, starting at the offending column
                []   // no post_context
            ];
        }

        return [
            context.slice(0, pivot),    // pre_context
            context[pivot],             // context_line
            context.slice(pivot + 1)    // post_context
        ];
    },

    _processException: function(type, message, fileurl, lineno, frames, options) {
        var stacktrace, fullMessage;

        if (!!this._globalOptions.ignoreErrors.test && this._globalOptions.ignoreErrors.test(message)) return;

        message += '';
        message = truncate(message, this._globalOptions.maxMessageLength);

        fullMessage = (type ? type + ': ' : '') + message;
        fullMessage = truncate(fullMessage, this._globalOptions.maxMessageLength);

        if (frames && frames.length) {
            fileurl = frames[0].filename || fileurl;
            // Sentry expects frames oldest to newest
            // and JS sends them as newest to oldest
            frames.reverse();
            stacktrace = {frames: frames};
        } else if (fileurl) {
            stacktrace = {
                frames: [{
                    filename: fileurl,
                    lineno: lineno,
                    in_app: true
                }]
            };
        }

        if (!!this._globalOptions.ignoreUrls.test && this._globalOptions.ignoreUrls.test(fileurl)) return;
        if (!!this._globalOptions.whitelistUrls.test && !this._globalOptions.whitelistUrls.test(fileurl)) return;

        var data = objectMerge({
            // sentry.interfaces.Exception
            exception: {
                values: [{
                    type: type,
                    value: message,
                    stacktrace: stacktrace
                }]
            },
            culprit: fileurl,
            message: fullMessage
        }, options);

        // Fire away!
        this._send(data);
    },

    _trimPacket: function(data) {
        // For now, we only want to truncate the two different messages
        // but this could/should be expanded to just trim everything
        var max = this._globalOptions.maxMessageLength;
        data.message = truncate(data.message, max);
        if (data.exception) {
            var exception = data.exception.values[0];
            exception.value = truncate(exception.value, max);
        }

        return data;
    },

    _getHttpData: function() {
        if (!this._hasDocument || !document.location || !document.location.href) {
            return;
        }

        var httpData = {
            headers: {
                'User-Agent': navigator.userAgent
            }
        };

        httpData.url = document.location.href;

        if (document.referrer) {
            httpData.headers.Referer = document.referrer;
        }

        return httpData;
    },


    _send: function(data) {
        var self = this;

        var globalOptions = this._globalOptions;

        var baseData = {
            project: this._globalProject,
            logger: globalOptions.logger,
            platform: 'javascript'
        }, httpData = this._getHttpData();

        if (httpData) {
            baseData.request = httpData;
        }

        data = objectMerge(baseData, data);

        // Merge in the tags and extra separately since objectMerge doesn't handle a deep merge
        data.tags = objectMerge(objectMerge({}, this._globalContext.tags), data.tags);
        data.extra = objectMerge(objectMerge({}, this._globalContext.extra), data.extra);

        // Send along our own collected metadata with extra
        data.extra['session:duration'] = now() - this._startTime;

        if (this._breadcrumbs && this._breadcrumbs.length > 0) {
            // intentionally make shallow copy so that additions
            // to breadcrumbs aren't accidentally sent in this request
            data.breadcrumbs = {
                values: [].slice.call(this._breadcrumbs, 0)
            };
        }

        // If there are no tags/extra, strip the key from the payload alltogther.
        if (isEmptyObject(data.tags)) delete data.tags;

        if (this._globalContext.user) {
            // sentry.interfaces.User
            data.user = this._globalContext.user;
        }

        // Include the release if it's defined in globalOptions
        if (globalOptions.release) data.release = globalOptions.release;

        // Include server_name if it's defined in globalOptions
        if (globalOptions.serverName) data.server_name = globalOptions.serverName;

        if (isFunction(globalOptions.dataCallback)) {
            data = globalOptions.dataCallback(data) || data;
        }

        // Why??????????
        if (!data || isEmptyObject(data)) {
            return;
        }

        // Check if the request should be filtered or not
        if (isFunction(globalOptions.shouldSendCallback) && !globalOptions.shouldSendCallback(data)) {
            return;
        }

        // Send along an event_id if not explicitly passed.
        // This event_id can be used to reference the error within Sentry itself.
        // Set lastEventId after we know the error should actually be sent
        this._lastEventId = data.event_id || (data.event_id = uuid4());

        // Try and clean up the packet before sending by truncating long values
        data = this._trimPacket(data);

        this._logDebug('debug', 'Raven about to send:', data);

        if (!this.isSetup()) return;

        var auth = {
            sentry_version: '7',
            sentry_client: 'raven-js/' + this.VERSION,
            sentry_key: this._globalKey
        };
        if (this._globalSecret) {
            auth.sentry_secret = this._globalSecret;
        }

        this.captureBreadcrumb('sentry', {
            message: data.message,
            eventId: data.event_id
        });

        var url = this._globalEndpoint;
        (globalOptions.transport || this._makeRequest).call(this, {
            url: url,
            auth: auth,
            data: data,
            options: globalOptions,
            onSuccess: function success() {
                self._triggerEvent('success', {
                    data: data,
                    src: url
                });
            },
            onError: function failure() {
                self._triggerEvent('failure', {
                    data: data,
                    src: url
                });
            }
        });
    },

    _makeRequest: function(opts) {
        var request = new XMLHttpRequest();

        if (request.send.toString() === 'function send() { [native code] }') {
            throw new Error('shouldnt get here');
        }
        // if browser doesn't support CORS (e.g. IE7), we are out of luck
        var hasCORS =
            'withCredentials' in request ||
            typeof XDomainRequest !== 'undefined';

        if (!hasCORS) return;

        var url = opts.url;
        function handler() {
            if (request.status === 200) {
                if (opts.onSuccess) {
                    opts.onSuccess();
                }
            } else if (opts.onError) {
                opts.onError();
            }
        }

        if ('withCredentials' in request) {
            request.onreadystatechange = function () {
                if (request.readyState !== 4) {
                    return;
                }
                handler();
            };
        } else {
            request = new XDomainRequest();
            // xdomainrequest cannot go http -> https (or vice versa),
            // so always use protocol relative
            url = url.replace(/^https?:/, '');

            // onreadystatechange not supported by XDomainRequest
            request.onload = handler;
        }

        // NOTE: auth is intentionally sent as part of query string (NOT as custom
        //       HTTP header) so as to avoid preflight CORS requests
        request.open('POST', url + '?' + urlencode(opts.auth));
        request.send(JSON.stringify(opts.data));
    },

    // Note: this is shitty, but I can't figure out how to get
    // sinon to stub document.createElement without breaking everything
    // so this wrapper is just so I can stub it for tests.
    _newImage: function() {
        return document.createElement('img');
    },

    _logDebug: function(level) {
        if (this._originalConsoleMethods[level] && this.debug) {
            // In IE<10 console methods do not have their own 'apply' method
            Function.prototype.apply.call(
                this._originalConsoleMethods[level],
                this._originalConsole,
                [].slice.call(arguments, 1)
            );
        }
    },

    _mergeContext: function(key, context) {
        if (isUndefined(context)) {
            delete this._globalContext[key];
        } else {
            this._globalContext[key] = objectMerge(this._globalContext[key] || {}, context);
        }
    }
};

// Deprecations
Raven.prototype.setUser = Raven.prototype.setUserContext;
Raven.prototype.setReleaseContext = Raven.prototype.setRelease;

module.exports = Raven;
