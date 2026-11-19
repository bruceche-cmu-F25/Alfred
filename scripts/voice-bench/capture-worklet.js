// Hands the microphone's samples (mono, the context's own rate) to the page in small batches.
// The page sends "flush" when recording stops, to get the last partial batch.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.port.postMessage(this.buffer.slice(0, this.length));
        this.length = 0;
        this.port.postMessage("flushed");
      }
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      if (this.length + channel.length > this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0, this.length));
        this.length = 0;
      }
      this.buffer.set(channel, this.length);
      this.length += channel.length;
    }
    return true;
  }
}
registerProcessor("capture", Capture);
