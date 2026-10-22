// Node's `stream`, reduced to the one name sax 1.2.4 reads when it loads:
// `SAXStream.prototype` is built on `Stream.prototype`. xml2js drives sax's
// plain parser and never creates a SAXStream, so nothing calls this.

exports.Stream = function Stream() {};
