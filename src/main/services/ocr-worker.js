const { parentPort } = require('worker_threads');
const Tesseract = require('tesseract.js');

parentPort.on('message', async (message) => {
    try {
        const { id, action, data } = message;
        if (action === 'recognize') {
            const buffer = Buffer.from(data.split(',')[1], 'base64');
            const worker = await Tesseract.createWorker('eng+tur', 1, { load_system_dawg: '0', load_freq_dawg: '0' });
            const { data: { text } } = await worker.recognize(buffer);
            await worker.terminate();
            parentPort.postMessage({ id, success: true, result: text.trim() });
        }
    } catch (err) {
        parentPort.postMessage({ id: message.id, success: false, error: err.message });
    }
});
