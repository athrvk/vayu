// Node's `timers`, reduced to setImmediate, which xml2js 0.6.2 calls for each
// chunk of an `async: true` parse. The script sandbox has no setImmediate, so
// a zero-delay setTimeout stands in; the sandbox drains its timers before a
// script ends, so the parse's callback still runs inside the script.

exports.setImmediate = function (callback, ...args) {
	return setTimeout(() => callback(...args), 0);
};
