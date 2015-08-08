// Very simple HTTP request library for Node.js
// Copyright (c) 2015 Joseph Huckaby
// Released under the MIT License

var fs = require('fs');
var http = require('http');
var https = require('https');
var querystring = require('querystring');
var zlib = require('zlib');
var util = require('util');

var FormData = require('form-data');
var XML = require('pixl-xml');

module.exports = {
	
	defaultHeaders: {
		'User-Agent': "PixlRequest " + require('./package.json').version,
		'Accept-Encoding': "gzip"
	},
	
	// default idle timeout of 30 seconds
	defaultTimeout: 30000,
	
	json: function(url, data, options, callback) {
		// convenience method: post json, get json back
		if (!callback) {
			// support 3-arg calling convention
			callback = options;
			options = {};
		}
		
		options.json = true;
		options.data = data;
		
		this.post( url, options, function(err, res, data) {
			// got response, check for http error
			if (err) return callback( err );
			
			// parse json in response
			var json = null;
			try { json = JSON.parse( data.toString() ); }
			catch (err) {
				return callback( err );
			}
			
			// all good, send json object back
			callback( null, res, json );
		} );
	},
	
	xml: function(url, data, options, callback) {
		// convenience method: post xml, get xml back
		if (!callback) {
			// support 3-arg calling convention
			callback = options;
			options = {};
		}
		
		options.xml = true;
		options.data = data;
		
		this.post( url, options, function(err, res, data) {
			// got response, check for http error
			if (err) return callback( err );
			
			// parse xml in response
			var xml = null;
			try { xml = XML.parse( data.toString() ); }
			catch (err) {
				return callback( err );
			}
			
			// all good, send xml object back
			callback( null, res, xml );
		} );
	},
	
	get: function(url, options, callback) {
		// perform HTTP GET
		// callback will receive: err, res, data
		if (!callback) {
			// support two-argument calling convention: url and callback
			callback = options;
			options = {};
		}
		if (!options) options = {};
		options.method = 'GET';
		this.request( url, options, callback );
	},
	
	post: function(url, options, callback) {
		// perform HTTP POST, raw data or key/value pairs
		// callback will receive: err, res, data
		if (!options) options = {};
		if (!options.headers) options.headers = {};
		if (!options.data) options.data = '';
		
		options.method = 'POST';
		
		if (typeof(options.data) == 'object') {
			// serialize data into key/value pairs
			if (options.json) {
				// JSON REST
				options.data = JSON.stringify(options.data) + "\n";
				options.headers['Content-Type'] = 'application/json';
				delete options.json;
			}
			else if (options.xml) {
				// XML REST
				options.data = XML.stringify(options.data, options.xmlRootNode || 'Request') + "\n";
				options.headers['Content-Type'] = 'text/xml';
				delete options.xml;
				delete options.xmlRootNode;
			}
			else if (options.files || options.multipart) {
				// use FormData
				var form = new FormData();
				
				// POST params (strings or Buffers)
				for (var key in options.data) {
					form.append(key, options.data[key]);
				}
				
				// file uploads
				if (options.files) {
					for (var key in options.files) {
						var file = options.files[key];
						if (typeof(file) == 'string') {
							// simple file path, convert to readable stream
							form.append( key, fs.createReadStream(file) );
						}
						else if (util.isArray(file)) {
							// array of [file path or stream or buffer, filename]
							var file_data = file[0];
							if (typeof(file_data) == 'string') file_data = fs.createReadStream(file_data);
							
							form.append( key, file_data, {
								filename: file[1]
							} );
						}
						else {
							// assume user knows what (s)he is doing (should be stream or buffer)
							form.append( key, file );
						}
					} // foreach file
					delete options.files;
				} // files
				
				options.data = form;
			} // multipart
			else {
				// form urlencoded
				options.data = querystring.stringify(options.data);
				options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
			}
		} // serialize data
		
		this.request( url, options, callback );
	},
	
	request: function(url, options, callback) {
		// low-level request sender
		// callback will receive: err, res, data
		if (!options) options = {};
		
		// if no agent is specified, use close connections
		if (!('agent' in options)) {
			options.agent = false;
			options.keepAlive = false;
		}
		
		// parse url into parts
		var parts = require('url').parse(url);
		if (!options.hostname) options.hostname = parts.hostname;
		if (!options.port) options.port = parts.port || ((parts.protocol == 'https:') ? 443 : 80);
		if (!options.path) options.path = parts.path;
		
		// default headers
		if (!options.headers) options.headers = {};
		for (var key in this.defaultHeaders) {
			if (!(key in options.headers)) {
				options.headers[key] = this.defaultHeaders[key];
			}
		}
		
		// prep post data
		var post_data = null;
		var is_form = false;
		
		if (('data' in options) && (options.data !== null)) {
			post_data = options.data;
			delete options.data;
			
			// support FormData and raw data
			if (post_data instanceof FormData) {
				// allow form-data to populate headers (multipart boundary, etc.)
				is_form = true;
				var form_headers = post_data.getHeaders();
				for (var key in form_headers) {
					options.headers[key] = form_headers[key];
				}
			}
			else {
				// raw data (string or buffer)
				options.headers['Content-Length'] = post_data.length;
			}
		}
		
		// handle timeouts
		var aborted = false;
		var timeout = this.defaultTimeout;
		if ('timeout' in options) {
			timeout = options.timeout;
			delete options.timeout;
		}
		
		// construct request object
		var proto_class = (parts.protocol == 'https:') ? https : http;
		var req = proto_class.request( options, function(res) {
			// got response headers
			var chunks = [];
			var total_bytes = 0;
			res.on('data', function (chunk) {
				// got chunk of data
				chunks.push( chunk );
				total_bytes += chunk.length;
			} );
			res.on('end', function() {
				// end of response, prepare data
				if (total_bytes) {
					var buf = Buffer.concat(chunks, total_bytes);
					
					// check for gzip encoding
					if (res.headers['content-encoding'] && res.headers['content-encoding'].match(/\bgzip\b/i) && callback) {
						zlib.gunzip( buf, function(err, data) {
							callback( err, res, data );
						} );
					}
					else {
						// response content is not encoded
						if (callback) callback( null, res, buf );
					}
				}
				else {
					// response content is empty
					if (callback) callback( null, res, '' );
				}
			} );
		} );
		
		req.on('error', function(e) {
			// handle socket errors
			if (callback && !aborted) callback(e);
		} );
		
		if (timeout) {
			// set idle socket timeout which aborts the request
			req.setTimeout( timeout, function() {
				aborted = true;
				req.abort();
				if (callback) callback( new Error("Socket Timeout ("+timeout+" ms)") );
			} );
		}
		
		if (post_data !== null) {
			// write post data to socket
			if (is_form) post_data.pipe( req );
			else {
				req.write( post_data );
				req.end();
			}
		}
		else req.end();
	}
	
};