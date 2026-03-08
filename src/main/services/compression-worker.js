const { parentPort } = require('worker_threads');
const zlib = require('zlibjs/bin/node-zlib.js');

parentPort.on('message', (message) => {
    try {
        const { id, action, data } = message;
        if (action === 'compress') {
            const buffer = Buffer.from(data, 'utf8');
            const compressed = zlib.deflateSync(buffer);
            const base64 = Buffer.from(compressed).toString('base64');
            parentPort.postMessage({ id, success: true, result: base64 });
        } else if (action === 'decompress') {
            const buffer = Buffer.from(data, 'base64');
            const decompressed = zlib.inflateSync(buffer);
            const text = Buffer.from(decompressed).toString('utf8');
            parentPort.postMessage({ id, success: true, result: text });
        } else if (action === 'decompress-batch') {
            const results = data.map(base64 => {
                const buffer = Buffer.from(base64, 'base64');
                const decompressed = zlib.inflateSync(buffer);
                return Buffer.from(decompressed).toString('utf8');
            });
            parentPort.postMessage({ id, success: true, result: results });
        }
    } catch (err) {
        parentPort.postMessage({ id: message.id, success: false, error: err.message });
    }
});
