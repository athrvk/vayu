// The Node built-ins csv-parse 1.2.4 requires, reduced to what its sync API
// (lib/sync.js) reaches. esbuild aliases `stream`, `util` and `string_decoder`
// to this file and injects its `Buffer` as a bundle-local binding, so the
// output defines no global. README.md beside it has the build command.
//
// The sync API never streams: it replaces the parser's push() and calls
// __write() and _flush() itself, so the stream machinery is never entered.
// What it does reach is the Transform constructor, util.inherits, a decoder's
// end(), `instanceof Buffer`, and emit('error'), which in Node throws the error
// when nothing listens; that throw is how an unterminated quote surfaces.

export function Transform() {}

Transform.prototype.emit = function (type, err) {
	if (type === "error") throw err;
	return false;
};

export function inherits(ctor, superCtor) {
	ctor.super_ = superCtor;
	Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

// Input is a string, which Node's StringDecoder.write() returns unchanged.
export function StringDecoder() {}

StringDecoder.prototype.write = function (chunk) {
	return chunk;
};

StringDecoder.prototype.end = function () {
	return "";
};

// No value is an instance of this, so the library's Buffer branches are not
// taken; Buffer input is not supported.
export function Buffer() {
	throw new TypeError("csv-parse: Buffer input is not supported");
}

Buffer.isBuffer = function () {
	return false;
};
