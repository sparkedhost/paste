const winston = require('winston');
const Busboy = require('busboy');

// For handling serving stored documents

var DocumentHandler = function(options) {
  if (!options) {
    options = {};
  }
  this.keyLength = options.keyLength || DocumentHandler.defaultKeyLength;
  this.maxLength = options.maxLength; // none by default
  this.store = options.store;
  this.keyGenerator = options.keyGenerator;
};

DocumentHandler.defaultKeyLength = 10;

// Handle retrieving a document
DocumentHandler.prototype.handleGet = function(request, response, config) {
  const key = request.params.id.split('.')[0];
  const skipExpire = !!config.documents[key];

  this.store.get(key, function(ret) {
    let responseCode;
    let responseBody;

    if (ret) {
      winston.verbose('Successfully retrieved document:', { client: request.remoteAddress, key: key });
      responseCode = 200;
      responseBody = JSON.stringify({ data: ret, key: key });
    } else {
      winston.warn('Document not found:', { client: request.remoteAddress, key: key });
      responseCode = 404;
      responseBody = JSON.stringify({ message: 'Document not found.' });
    }

    response.writeHead(responseCode, { 'content-type': 'application/json' });

    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(responseBody);
    }
  }, skipExpire);
};

// Handle retrieving the raw version of a document
DocumentHandler.prototype.handleRawGet = function(request, response, config) {
  const key = request.params.id.split('.')[0];
  const skipExpire = !!config.documents[key];

  this.store.get(key, function(ret) {
    // Having responseCode here is pointless as the content-type header changes between conditions too
    let responseBody;

    if (ret) {
      winston.verbose('Successfully retrieved raw document:', { key: key });
      responseBody = ret;
      response.writeHead(200, { 'content-type': 'text/plain; charset=UTF-8' });
    } else {
      winston.warn('Raw document not found:', { key: key });
      responseBody = JSON.stringify({ message: 'Document not found.' });
      response.writeHead(404, { 'content-type': 'application/json' });
    }

    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(responseBody);
    }
  }, skipExpire);
};

// Handle adding a new Document
DocumentHandler.prototype.handlePost = function (request, response) {
  const _this = this;
  let buffer = '';
  let cancelled = false;

  // What to do when done
  let onSuccess = function () {
    // Check length

    /* Patch from https://github.com/zneix/haste-server/commit/04e1f09fedbaa9a83a6d747f033467e1f42f4d53
     * "It is no longer possible to make a POST request with no body content and make a "ghost key" - which upon requesting returns 404, but it considered as a taken key"
     * Credit: zneix
     */
    if (!buffer.length){
      cancelled = true;
      winston.warn('document with no length was POSTed');
      response.status(411).json({ message: 'Length required.' });
      return;
    }

    if (_this.maxLength && buffer.length > _this.maxLength) {
      cancelled = true;
      winston.warn('document >maxLength', {maxLength: _this.maxLength});
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(
          JSON.stringify({message: 'Document exceeds maximum length.'})
      );
      return;
    }
    // And then save if we should
    _this.chooseKey(function (key) {
      _this.store.set(key, buffer, function (res) {
        if (res) {
          winston.verbose('added document', {key: key});
          response.writeHead(200, {'content-type': 'application/json'});
          response.end(JSON.stringify({key: key}));
        } else {
          winston.verbose('error adding document');
          response.writeHead(500, {'content-type': 'application/json'});
          response.end(JSON.stringify({message: 'Error adding document.'}));
        }
      });
    });
  };

  // If we should, parse a form to grab the data
  const ct = request.headers['content-type'];
  if (ct && ct.split(';')[0] === 'multipart/form-data') {
    const busboy = new Busboy({headers: request.headers});
    busboy.on('field', function (fieldname, val) {
      if (fieldname === 'data') {
        buffer = val;
      }
    });
    busboy.on('finish', function () {
      onSuccess();
    });
    request.pipe(busboy);
  // Otherwise, use our own and just grab flat data from POST body
  } else {
    request.on('data', function (data) {
      buffer += data.toString();
    });
    request.on('end', function () {
      if (cancelled) { return; }
      onSuccess();
    });
    request.on('error', function (error) {
      winston.error('connection error: ' + error.message);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'Connection error.' }));
      cancelled = true;
    });
  }
};

// Keep choosing keys until one isn't taken
DocumentHandler.prototype.chooseKey = function(callback) {
  const key = this.acceptableKey();
  const _this = this;
  this.store.get(key, function(ret) {
    if (ret) {
      _this.chooseKey(callback);
    } else {
      callback(key);
    }
  }, true); // Don't bump expirations when key searching
};

DocumentHandler.prototype.acceptableKey = function() {
  return this.keyGenerator.createKey(this.keyLength);
};

module.exports = DocumentHandler;
