/**
 * Sample-accurate 4-stroke exhaust + 12V starter.
 * Single output: combustion + starter/intake mixed. A missing second
 * output used to overwrite the engine with silence.
 */
const TWO_PI = Math.PI * 2;

function krate(arr, fallback) {
  if (!arr || arr.length < 1) return fallback;
  return arr[0];
}

class CombustionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.firePh = 0;
    this.crankRev = 0;
    this.cyl = 0;
    this.env = 0;
    this.thump = 0;
    this.lp = 0;
    this.brown = 0;
    this.seed = 1650565;
    this.stPh = 0;
    this.stHp = 0;
    this.stLp = 0;
    this.toothPh = 0;
    this.click = 0;
    this.prevBackfire = 0;
    this.backfireEnv = 0;
    this.intakeLp = 0;
    this.tickPh = 0;
    this.tickEnv = 0;
    this.pipe = new Float32Array(1024);
    this.pi = 0;
    this.muff = new Float32Array(2048);
    this.mi = 0;
    this.muffLp = 0;
    this.pipeLp = 0;
    this.cylGain = [1, 0.9, 0.97, 0.84];
  }

  rand() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  process(_inputs, outputs, params) {
    const ex = outputs[0] && outputs[0][0];
    if (!ex) return true;

    const sr = sampleRate;
    const dt = 1 / sr;
    const rpmA = params.rpm;
    const load = krate(params.load, 0);
    const combust = krate(params.combust, 0);
    const starter = krate(params.starter, 0);
    const irreg = krate(params.irregular, 0);
    const fuelCut = krate(params.fuelCut, 0);
    const backfire = krate(params.backfire, 0);
    const intake = krate(params.intake, 0);
    const cylN = Math.max(1, Math.min(12, krate(params.cylinders, 4)));

    const pipeLen = this.pipe.length;
    const muffLen = this.muff.length;
    const pipeDelay = Math.max(12, Math.min(pipeLen - 1, (sr * 0.0038) | 0));
    const muffDelay = Math.max(24, Math.min(muffLen - 1, (sr * 0.0088) | 0));

    for (let i = 0; i < ex.length; i++) {
      const rpm = Math.max(0, rpmA && rpmA.length > 1 ? rpmA[i] : krate(rpmA, 0));

      const white = this.rand() * 2 - 1;
      this.brown += 0.014 * (white - this.brown);

      const fireHz = (rpm / 60) * (cylN * 0.5);
      const jitter = 1 + irreg * (this.rand() - 0.5) * 0.12;
      this.firePh += Math.max(0, fireHz) * jitter * dt;
      this.crankRev += (rpm / 60) * dt;

      if (this.firePh >= 1) {
        this.firePh -= 1;
        if (this.firePh >= 1) this.firePh = 0;
        this.cyl = (this.cyl + 1) & 3;
        const miss = this.rand() < irreg * 0.55;
        const cut = fuelCut > 0.5 && this.rand() < 0.62;
        const g = this.cylGain[this.cyl];
        if (combust > 0.02 && !miss && !cut) {
          const punch = (0.38 + load * 0.72 + this.rand() * 0.08) * g;
          this.env = punch;
          this.thump = punch * (0.85 + load * 0.2);
        } else if (starter > 0.1 && this.rand() > 0.22) {
          this.thump = (0.18 + this.rand() * 0.12) * g;
        }
      }

      const crackTau = 0.0024 + load * 0.0012;
      const bodyTau = 0.010 + load * 0.007;
      this.env *= Math.exp(-dt / crackTau);
      this.thump *= Math.exp(-dt / bodyTau);

      const crack = (white * 0.55 + this.brown * 0.45) * this.env;
      const body = this.thump * (0.55 + this.brown * 0.7);
      const raw = crack * 1.15 + body * 1.35;

      const lpA = 0.07 + Math.min(0.28, rpm * 0.000045) + load * 0.07;
      this.lp += lpA * (raw - this.lp);

      const pRead = this.pipe[(this.pi - pipeDelay + pipeLen) % pipeLen];
      this.pipeLp += 0.18 * (pRead - this.pipeLp);
      const piped = this.lp + this.pipeLp * (0.08 + load * 0.05);
      this.pipe[this.pi] = this.lp;
      this.pi = (this.pi + 1) % pipeLen;

      const mRead = this.muff[(this.mi - muffDelay + muffLen) % muffLen];
      this.muffLp += 0.11 * (mRead - this.muffLp);
      let pulse = piped * 0.78 + this.muffLp * (0.1 + (1 - load) * 0.06);
      this.muff[this.mi] = piped;
      this.mi = (this.mi + 1) % muffLen;

      if (backfire > 0.5 && this.prevBackfire <= 0.5) {
        this.backfireEnv = 1.7;
      }
      this.prevBackfire = backfire;
      this.backfireEnv *= Math.exp(-dt / 0.055);
      if (this.backfireEnv > 0.002) {
        pulse += this.backfireEnv * (white * 0.7 + this.brown * 1.1 + this.thump * 0.8);
      }

      const x = pulse * combust * 0.9;
      const exhaust = x / (1 + Math.abs(x) * 0.85);

      let st = 0;
      if (starter > 0.001) {
        const motorHz = 95 + rpm * 0.55;
        this.stPh += motorHz * dt;
        if (this.stPh > 1) this.stPh -= 1;
        const pwm = this.stPh < 0.62 ? 1 : 0.22;
        this.stLp += 0.09 * (this.brown - this.stLp);
        this.stHp = this.brown - this.stLp;
        this.toothPh += (180 + rpm * 1.1) * dt;
        if (this.toothPh > 1) this.toothPh -= 1;
        if (this.toothPh < 0.035) this.click = 0.7 + this.rand() * 0.3;
        this.click *= Math.exp(-dt / 0.0009);
        const lope = 0.7 + 0.3 * Math.sin(this.crankRev * TWO_PI * 2);
        st =
          starter *
          lope *
          (this.stHp * 1.55 * pwm +
            this.stLp * 0.9 +
            this.click * white * 0.55 +
            this.thump * 0.45);
      }

      const inN = white * 0.55 + this.brown * 0.45;
      this.intakeLp += 0.2 * (inN - this.intakeLp);
      const inSig = (inN - this.intakeLp * 0.4) * intake * 0.42;

      this.tickPh += Math.max(0, (rpm / 60) * 2) * dt;
      if (this.tickPh >= 1) {
        this.tickPh -= 1;
        if (combust > 0.15 && starter < 0.2 && rpm < 1800) this.tickEnv = 0.22;
      }
      this.tickEnv *= Math.exp(-dt / 0.0012);
      const tick = this.tickEnv * white * 0.18;

      const mech = st + inSig + tick;
      const y = mech / (1 + Math.abs(mech) * 0.7);
      const mixed = exhaust + y * 0.95;
      ex[i] = mixed < -1 ? -1 : mixed > 1 ? 1 : mixed;
    }
    return true;
  }

  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 9000, automationRate: 'a-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'combust', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'starter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'irregular', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'fuelCut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'backfire', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'intake', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cylinders', defaultValue: 4, minValue: 1, maxValue: 12, automationRate: 'k-rate' },
    ];
  }
}

registerProcessor('combustion-processor', CombustionProcessor);
