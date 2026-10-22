// Node's `string_decoder`, which sax 1.2.4 requires only inside
// SAXStream.write() for a Buffer chunk. xml2js drives sax's plain parser and
// never creates a SAXStream, and the sandbox has no Buffer, so this is never
// reached; it exists so the bundle names no free `require`.

exports.StringDecoder = function StringDecoder() {
	throw new TypeError("xml2js: Buffer input is not supported");
};
