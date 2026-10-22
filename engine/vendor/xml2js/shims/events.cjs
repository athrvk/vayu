// Node's `events`, reduced to what xml2js 0.6.2's Parser reaches. esbuild
// aliases `events` to this file (README.md beside the directory has the build).
//
// The Parser extends the module itself (`extend(Parser, events)`), so the
// module is the constructor. CoffeeScript's `extend` never calls it, so the
// listener table is created on first use rather than in the constructor.
// What the Parser calls is on(), emit() and removeAllListeners(); emit() calls
// each listener with the emitter as `this` (the parser's own `end` listener
// calls `this.reset()`, which removes every listener mid-emit, so the list is
// copied first, as Node does), and emit('error') with nothing listening throws
// the error, as Node does. once(), off(), listeners() and the rest of Node's
// emitter are not provided.

function EventEmitter() {}

function listenersOf(emitter) {
	if (!emitter._events) {
		emitter._events = Object.create(null);
	}
	return emitter._events;
}

EventEmitter.prototype.on = function (type, listener) {
	const events = listenersOf(this);
	(events[type] || (events[type] = [])).push(listener);
	return this;
};

EventEmitter.prototype.addListener = EventEmitter.prototype.on;

EventEmitter.prototype.emit = function (type, ...args) {
	const listeners = listenersOf(this)[type];
	if (!listeners || listeners.length === 0) {
		if (type === "error") {
			throw args[0] instanceof Error ? args[0] : new Error("Unhandled error.");
		}
		return false;
	}
	for (const listener of listeners.slice()) {
		listener.apply(this, args);
	}
	return true;
};

EventEmitter.prototype.removeAllListeners = function (type) {
	if (type === undefined) {
		this._events = Object.create(null);
	} else {
		delete listenersOf(this)[type];
	}
	return this;
};

EventEmitter.EventEmitter = EventEmitter;

module.exports = EventEmitter;
