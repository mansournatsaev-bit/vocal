// Capte le micro en PCM 16 bits mono, par paquets de 1024 échantillons (~21 ms).
// Rien n'est joué : la sortie reste silencieuse.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.paquet = new Int16Array(1024);
    this.n = 0;
  }

  process(entrees) {
    const canal = entrees[0] && entrees[0][0];
    if (canal) {
      for (let i = 0; i < canal.length; i++) {
        const s = Math.max(-1, Math.min(1, canal[i]));
        this.paquet[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.paquet.length) {
          this.port.postMessage(this.paquet, [this.paquet.buffer]);
          this.paquet = new Int16Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', Capture);
