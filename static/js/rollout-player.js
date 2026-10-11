/* Recorded episode steps are the common clock for video, paths, and estimates. */
(() => {
  'use strict';
  const SVG = 'http://www.w3.org/2000/svg';
  const players = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activePlayer = null;
  let instanceId = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgNode(tag, attributes = {}, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, action, title = text) {
    const node = element('button', 'rollout-button', text);
    node.type = 'button';
    node.title = title;
    node.addEventListener('click', action);
    return node;
  }

  const ICONS = {
    play: 'M8 5.5v13l10.5-6.5z',
    pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
    replay: 'M12 5V2L7.5 6l4.5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  };

  function setIcon(node, kind, label) {
    if (node.dataset.icon !== kind) {
      const icon = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
      icon.append(svgNode('path', { d: ICONS[kind] }));
      node.replaceChildren(icon);
      node.dataset.icon = kind;
    }
    node.setAttribute('aria-label', label);
    node.title = label;
  }

  // A small soccer ball: black pentagon patches clipped to a white ball, ringed in the skill color.
  let ballId = 0;
  function soccerBall(cx, cy, color, r = 6.5) {
    const group = svgNode('g', { transform: `translate(${cx},${cy})` });
    const id = `soccer-ball-${++ballId}`;
    const clip = svgNode('clipPath', { id });
    clip.append(svgNode('circle', { r }));
    const pentagon = (x0, y0, size, turn) => [0, 1, 2, 3, 4].map(k => {
      const angle = turn + k * 2 * Math.PI / 5;
      return `${(x0 + size * Math.cos(angle)).toFixed(2)},${(y0 + size * Math.sin(angle)).toFixed(2)}`;
    }).join(' ');
    const patches = svgNode('g', { 'clip-path': `url(#${id})`, fill: '#262a2c' });
    patches.append(svgNode('polygon', { points: pentagon(0, 0, 0.36 * r, -Math.PI / 2) }));
    for (let k = 0; k < 5; k++) {
      const angle = Math.PI / 2 + k * 2 * Math.PI / 5;
      patches.append(svgNode('polygon', { points: pentagon(1.02 * r * Math.cos(angle), 1.02 * r * Math.sin(angle), 0.34 * r, angle) }));
    }
    group.append(clip, svgNode('circle', { r, fill: '#fff' }), patches,
      svgNode('circle', { r: r + 0.6, fill: 'none', stroke: color, 'stroke-width': 1.8 }));
    return group;
  }

  function floorIndex(values, value) {
    let lo = 0;
    let hi = values.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (values[mid] <= value) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  class GuidedTimeline {
    constructor(rollout) {
      this.rollout = rollout;
      this.branch = 'all';
      this.step = 0;
      this.visited = new Set();
      this.barrier = null;
    }

    get variant() { return this.rollout.variants[this.branch]; }

    get pauses() {
      return this.rollout.events.filter(event => event.pause &&
        (event.branch === undefined || this.branch === 'all' || String(event.branch) === this.branch));
    }

    timeForStep(step) {
      const frames = this.variant.frameSteps;
      let i = floorIndex(frames, step);
      while (i > 0 && frames[i - 1] === step) i--;
      const span = i + 1 < frames.length ? frames[i + 1] - frames[i] : 0;
      const fraction = span > 0 ? (step - frames[i]) / span : 0;
      return (i + Math.max(0, fraction)) / this.variant.fps;
    }

    stepForTime(time) {
      const frames = this.variant.frameSteps;
      return frames[Math.min(frames.length - 1, Math.max(0, Math.floor(time * this.variant.fps + 0.001)))];
    }

    seek(step) {
      const clamped = Math.max(0, Math.min(this.variant.endStep, step));
      const event = this.pauses.find(item => item.step === clamped && item.poster);
      const frames = this.variant.frameSteps;
      this.step = event ? clamped : frames[floorIndex(frames, clamped)];
      this.visited = new Set(this.pauses.filter(item => item.step <= this.step).map(item => item.step));
      this.barrier = event || null;
      return this.step;
    }

    nextPause() {
      return this.pauses.find(event => event.step >= this.step && !this.visited.has(event.step));
    }

    advance(time) {
      const next = Math.max(this.step, this.stepForTime(time));
      const event = this.nextPause();
      if (event && event.step <= next) {
        this.step = event.step;
        this.visited.add(event.step);
        this.barrier = event;
        return event;
      }
      this.step = next;
      return null;
    }
  }

  class RolloutPlayer {
    constructor(root, manifest) {
      this.root = root;
      this.manifest = manifest;
      this.keys = (root.dataset.rollouts || root.dataset.rollout).split(',');
      this.key = this.keys[0];
      this.view = root.dataset.view || 'compact';
      this.visible = false;
      this.started = false;
      this.manualPause = false;
      this.playing = false;
      this.preparing = false;
      this.playToken = 0;
      this.failed = false;
      this.pauseTimer = null;
      this.frameCallback = null;
      this.bindToken = 0;
      this.id = `rollout-${++instanceId}`;
      this.build();
      this.selectEnvironment(this.key);
      root.rolloutPlayer = this;
      players.push(this);
    }

    get rollout() { return this.manifest.rollouts[this.key]; }
    get baseUrl() { return `${this.manifest.baseUrl}${this.key}/`; }
    get selectedBranches() {
      return this.rollout.branches.filter(branch => this.timeline.branch === 'all' || String(branch.id) === this.timeline.branch);
    }

    build() {
      this.ui = element('div', `rollout-player rollout-${this.view}`);
      if (this.keys.length > 1) {
        const tabs = element('div', 'rollout-tabs');
        tabs.setAttribute('role', 'group');
        tabs.setAttribute('aria-label', 'Choose an environment');
        this.tabs = this.keys.map(key => {
          const tab = button(this.manifest.rollouts[key].title, () => this.selectEnvironment(key));
          tab.setAttribute('aria-pressed', String(key === this.key));
          tabs.append(tab);
          return tab;
        });
        this.ui.append(tabs);
      }


      const body = element('div', 'rollout-body');
      this.stage = element('div', 'rollout-stage');
      this.video = element('video', 'rollout-video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.preload = 'none';
      this.video.setAttribute('aria-label', 'Recorded policy rollout');
      this.hold = element('img', 'rollout-hold');
      this.hold.hidden = true;
      this.hold.alt = 'Exact saved state at a teaching pause';
      // Phase name for the timeline's accessible value; not drawn over the footage.
      this.phase = element('span', 'sr-only', 'Potential policy');
      // Recorded direction of each Craftax skill after the switch, drawn over the frame.
      this.overlay = svgNode('svg', { class: 'rollout-overlay', viewBox: '0 0 9 9', 'aria-hidden': 'true' });
      // Skill names over the Craftax 2 x 2 grid after the switch.
      this.laneLabels = element('div', 'rollout-lane-labels');
      this.stage.append(this.video, this.hold, this.overlay, this.laneLabels, this.phase);
      this.stage.addEventListener('click', () => this.toggle());
      body.append(this.stage);
      this.chips = element('div', 'rollout-chips');
      this.chips.setAttribute('role', 'group');
      this.chips.setAttribute('aria-label', 'Choose a recorded skill branch');
      if (this.view === 'method') {
        const story = element('div', 'rollout-story');
        this.potentialCard = element('div', 'rollout-story-card');
        this.potentialCard.append(element('strong', '', '1. Reach an empowered state'),
          element('p', '', 'The potential policy moves to a state from which the agent can exert control.'));
        this.skillCard = element('div', 'rollout-story-card');
        this.skillCard.append(element('strong', '', '2. Execute a skill'),
          element('p', '', 'Skills branch from exactly the same switch state and produce different outcomes.'));
        story.append(this.potentialCard, this.skillCard, this.chips);
        body.append(story);
      } else if (this.view === 'explorer') {
        const panel = element('div', 'rollout-path-panel');
        // Described in the caption below, together with the phase sentence.
        this.pathTitle = element('span', 'rollout-path-note');
        this.pathSvg = svgNode('svg', { viewBox: '0 0 300 300', role: 'img', 'aria-label': 'Recorded trajectory, top view' });
        panel.append(this.pathSvg);
        body.append(panel);
      }
      this.ui.append(body);
      if (this.view === 'explorer') {
        this.chartTitle = element('div', 'rollout-plot-title');
        this.chartSvg = svgNode('svg', { viewBox: '0 0 720 250', role: 'img', 'aria-label': 'Estimated potential empowerment along the recorded episode' });
        const titleRow = element('div', 'rollout-chart-title');
        titleRow.append(this.chartTitle);
        // Described in the caption below, with the top view.
        this.chartNote = element('span', 'rollout-path-note');
        const chart = element('div', 'rollout-chart');
        chart.append(titleRow, this.chartSvg);
        this.ui.append(chart);  // Right below the footage and top view.
        // Clicking either plot plays or pauses, like clicking the footage.
        for (const plot of [this.chartSvg, this.pathSvg]) plot.addEventListener('click', () => this.toggle());
      }

      if (this.view !== 'mini' && this.view !== 'method') {
        this.message = element('p', 'rollout-message');
        this.messageTitle = element('strong');
        this.messageDetail = element('span');
        this.message.append(this.messageTitle, ' ', this.messageDetail);
        if (this.pathTitle) this.message.append(' ', this.pathTitle, ' ', this.chartNote);
        this.ui.append(this.message);
      }

      const controls = element('div', 'rollout-controls');
      this.playButton = button('Play', () => this.playing ? this.pause('manual') : this.play(true));
      this.playButton.classList.add('rollout-primary');
      this.playButton.setAttribute('aria-controls', this.id);
      const track = element('div', 'rollout-timeline');
      const label = element('label', 'sr-only', 'Scrub the recorded trajectory');
      label.htmlFor = `${this.id}-time`;
      this.slider = element('input', 'rollout-slider');
      this.slider.id = label.htmlFor;
      this.slider.type = 'range';
      this.slider.min = '0';
      this.slider.step = 'any';
      this.slider.value = '0';
      this.slider.addEventListener('input', () => this.seek(Math.round(Number(this.slider.value))));
      this.markers = element('div', 'rollout-markers');
      track.append(label, this.slider, this.markers);
      this.readout = element('output', 'rollout-step');
      controls.append(this.playButton, track, this.readout);
      this.ui.append(controls);
      if (this.view !== 'method' && this.view !== 'mini') this.ui.append(this.chips);


      this.status = element('span', 'sr-only');
      this.status.setAttribute('role', 'status');
      this.ui.append(this.status);
      this.video.id = this.id;
      this.video.addEventListener('timeupdate', () => this.tick(this.video.currentTime));
      this.video.addEventListener('ended', () => {
        if (!this.playing) return;
        this.timeline.step = this.timeline.variant.endStep;
        this.pause('ended');
        this.update();
      });
      this.video.addEventListener('error', () => {
        this.failed = true;
        this.pause('error');
        this.ui.hidden = true;
        this.root.querySelector('.rollout-fallback')?.removeAttribute('hidden');
      });
      this.root.append(this.ui);
      if (this.view === 'explorer' && 'ResizeObserver' in window) {
        const sizeLabels = () => {
          // Plot text matches the page's body text, independent of the SVG's scale.
          const bodyPx = parseFloat(getComputedStyle(document.body).fontSize);
          const displayPx = bodyPx;
          for (const svg of [this.pathSvg, this.chartSvg]) {
            const width = svg.getBoundingClientRect().width;
            if (width) svg.style.setProperty('--plot-font-size', `${displayPx * svg.viewBox.baseVal.width / width}px`);
          }
        };
        let lastWidth = 0;
        this.labelObserver = new ResizeObserver(() => {
          const width = Math.round(this.chartSvg.getBoundingClientRect().width);
          if (width && width !== lastWidth) { lastWidth = width; this.drawChart(); }
          sizeLabels();
        });
        this.labelObserver.observe(this.ui);
      }
      this.root.querySelector('.rollout-fallback')?.setAttribute('hidden', '');
    }

    // Every clip plays at the manifest's episode speed, whatever its encoded frame rate.
    applyRate() {
      const variant = this.timeline.variant, frames = variant.frameSteps;
      const native = (frames.at(-1) - frames[0]) / ((frames.length - 1) / variant.fps);
      const target = this.rollout.stepsPerSecond || this.manifest.stepsPerSecond;
      const rate = target && native > 0 ? target / native : 1;
      this.video.defaultPlaybackRate = rate;
      this.video.playbackRate = rate;
    }

    toggle() {
      if (this.playing) this.pause('manual');
      else this.play(true);
    }

    selectEnvironment(key) {
      this.pause('manual');
      this.key = key;
      this.timeline = new GuidedTimeline(this.rollout);
      const preferred = this.keys.length === 1 ? this.root.dataset.branch : undefined;
      if (preferred && this.rollout.variants[preferred]) this.timeline.branch = preferred;
      else if (!this.rollout.variants.all) this.timeline.branch = String(this.rollout.branches[0].id);
      this.started = false;
      this.manualPause = false;
      this.failed = false;
      if (this.tabs) this.tabs.forEach((tab, index) => tab.setAttribute('aria-pressed', String(this.keys[index] === key)));
      this.buildChips();
      this.rebuildMarkers();
      this.bindVideo();
      this.update();
    }

    buildChips() {
      const options = [];
      if (this.rollout.variants.all && this.rollout.branches.length > 1) options.push({ value: 'all', label: 'All skills' });
      for (const branch of this.rollout.branches) options.push({ value: String(branch.id), label: branch.label, color: branch.color });
      this.chips.replaceChildren();
      this.chips.hidden = options.length < 2;
      this.chipButtons = options.map(option => {
        const chip = button(option.label, () => this.selectBranch(option.value), `Show ${option.label.toLowerCase()}`);
        chip.className = 'rollout-chip';
        chip.dataset.branch = option.value;
        if (option.color) {
          const swatch = element('span', 'rollout-swatch');
          swatch.style.background = option.color;
          chip.prepend(swatch);
        }
        this.chips.append(chip);
        return chip;
      });
    }

    selectBranch(branch) {
      if (!this.rollout.variants[branch]) branch = String(this.rollout.branches[0].id);
      const step = this.timeline.step;
      this.pause('manual');
      this.timeline.branch = branch;
      this.timeline.seek(step);
      this.rebuildMarkers();
      this.bindVideo();
      this.update();
      this.announce(`${this.branchLabel(branch)} selected, paused at step ${this.timeline.step}.`);
    }

    bindVideo() {
      const token = ++this.bindToken;
      this.metadataReady = false;
      this.video.poster = this.baseUrl + this.rollout.poster;
      this.video.src = this.baseUrl + this.timeline.variant.video;
      this.video.onloadedmetadata = () => {
        if (token !== this.bindToken) return;
        this.metadataReady = true;
        this.video.currentTime = this.timeline.timeForStep(this.timeline.step);
        this.applyRate();
      };
      this.stage.classList.toggle('pixel-stage', this.key.startsWith('craftax'));
    }

    rebuildMarkers() {
      this.markers.replaceChildren();
      for (const event of this.timeline.pauses) {
        const isSwitch = event.step === this.rollout.switchStep;
        const marker = button('', () => this.seek(event.step), `${isSwitch ? 'Policy switch' : event.title} · episode step ${event.step}`);
        marker.className = 'rollout-marker';
        marker.setAttribute('aria-label', marker.title);
        marker.style.left = `${event.step / this.timeline.variant.endStep * 100}%`;
        marker.classList.toggle('switch-marker', isSwitch);
        this.markers.append(marker);
      }
    }

    seek(step) {
      this.pause('manual');
      this.timeline.seek(step);
      // An explicit scrub must decode a frame even before first playback.
      this.video.preload = 'auto';
      this.video.currentTime = this.timeline.timeForStep(this.timeline.step);
      this.update();
      this.announce(this.timeline.barrier?.title || `Paused at episode step ${this.timeline.step}.`);
    }

    replay() {
      this.timeline.visited.clear();
      this.timeline.barrier = null;
      this.timeline.step = 0;
      this.video.currentTime = 0;
      this.manualPause = false;
      this.update();
      this.play(true);
    }

    waitForVideo(event, ready) {
      if (ready()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          this.video.removeEventListener(event, loaded);
          this.video.removeEventListener('error', failed);
        };
        const loaded = () => { if (ready()) { cleanup(); resolve(); } };
        const failed = () => { cleanup(); reject(new Error('The rollout video could not load.')); };
        this.video.addEventListener(event, loaded);
        this.video.addEventListener('error', failed);
      });
    }

    async play(manual = false) {
      if (this.failed || (!manual && (reducedMotion.matches || this.manualPause || this.timeline.barrier))) return;
      if (activePlayer && activePlayer !== this) activePlayer.pause('viewport');
      activePlayer = this;
      const token = ++this.playToken;
      if (this.timeline.step >= this.timeline.variant.endStep) {
        this.timeline.visited.clear();
        this.timeline.step = 0;
        this.video.currentTime = 0;
      }
      this.manualPause = false;
      this.started = true;
      this.playing = true;
      this.preparing = true;
      this.video.preload = 'auto';
      this.update();
      try {
        // readyState can briefly describe the previous source after src changes.
        if (!this.metadataReady) this.video.load();
        await this.waitForVideo('loadedmetadata', () => this.metadataReady && this.video.readyState >= 1);
        if (token !== this.playToken || !this.playing) return;
        // A freshly selected source can still be at zero behind the switch still.
        // Finish the seek before removing that still or starting the decoder.
        const target = this.timeline.timeForStep(this.timeline.step);
        this.video.currentTime = target;
        await this.waitForVideo('seeked', () => !this.video.seeking && Math.abs(this.video.currentTime - target) < 0.02);
        if (token !== this.playToken || !this.playing) return;
        this.preparing = false;
        this.timeline.barrier = null;
        this.update();
        this.applyRate();
        await this.video.play();
        if (token !== this.playToken || !this.playing) return;
        this.armPause();
        this.requestFrame();
        this.glide();
      } catch (error) {
        if (error.name === 'AbortError') return;
        this.pause('manual');
        this.announce('Press Play to start the recorded rollout.');
      }
    }

    pause(reason) {
      this.playToken++;
      this.playing = false;
      this.preparing = false;
      this.video?.pause();
      clearTimeout(this.pauseTimer);
      if (this.frameCallback !== null && this.video?.cancelVideoFrameCallback) {
        this.video.cancelVideoFrameCallback(this.frameCallback);
        this.frameCallback = null;
      }
      if (reason === 'manual' || reason === 'ended') this.manualPause = true;
      if (this.timeline) this.update();
    }

    armPause() {
      clearTimeout(this.pauseTimer);
      if (!this.playing) return;
      const event = this.timeline.nextPause();
      if (!event || event.step > this.timeline.variant.endStep) return;
      const delay = (this.timeline.timeForStep(event.step) - this.video.currentTime) / this.video.playbackRate * 1000;
      this.pauseTimer = setTimeout(() => {
        // Buffering must not let a wall-clock timer skip ahead in the episode.
        if (this.video.currentTime + 0.001 < this.timeline.timeForStep(event.step)) this.armPause();
        else this.holdAt(event);
      }, Math.max(16, delay));
    }

    holdAt(event) {
      if (!this.playing) return;
      this.timeline.step = event.step;
      this.timeline.visited.add(event.step);
      this.timeline.barrier = event;
      this.pause('teaching');
      this.video.currentTime = this.timeline.timeForStep(event.step);
      this.update();
      this.announce(`${event.title}. ${event.detail} Press ${event.step === this.rollout.switchStep ? 'Play skills' : 'Continue'} to continue.`);
    }

    tick(time) {
      if (!this.playing || this.preparing) return;
      const event = this.timeline.advance(time);
      if (event) this.holdAt(event);
      else this.update();
    }

    // Move the timeline continuously between encoded frames while playing.
    glide() {
      if (!this.playing || this.preparing) return;
      const variant = this.timeline.variant, frames = variant.frameSteps;
      // Some browsers report currentTime only once per decoded frame, so extrapolate
      // from the last reported time with the wall clock, capped at the next frame.
      const now = performance.now();
      if (this.video.currentTime !== this.glideTime) { this.glideTime = this.video.currentTime; this.glideStamp = now; }
      const time = this.glideTime + Math.min(1 / variant.fps, (now - this.glideStamp) / 1000 * this.video.playbackRate);
      const position = time * variant.fps;
      const index = Math.min(frames.length - 1, Math.floor(position));
      const next = frames[Math.min(frames.length - 1, index + 1)];
      const smooth = Math.max(this.timeline.step, Math.min(variant.endStep, frames[index] + (next - frames[index]) * (position - index)));
      this.slider.value = String(smooth);
      this.slider.style.setProperty('--progress', String(smooth / variant.endStep));
      requestAnimationFrame(() => this.glide());
    }

    requestFrame() {
      if (!this.video.requestVideoFrameCallback || !this.playing) return;
      this.frameCallback = this.video.requestVideoFrameCallback((_, metadata) => {
        this.frameCallback = null;
        this.tick(metadata.mediaTime);
        if (this.playing) this.requestFrame();
      });
    }

    announce(text) { this.status.textContent = text; }

    branchLabel(id) {
      return id === 'all' ? 'All skills' : this.rollout.branches.find(branch => String(branch.id) === String(id))?.label || `Skill ${id}`;
    }

    update() {
      if (!this.timeline) return;
      const { step, branch, barrier } = this.timeline;
      const skillPhase = step > this.rollout.switchStep;
      const atSwitch = step === this.rollout.switchStep;
      this.ui.classList.toggle('is-playing', this.playing);
      this.ui.classList.toggle('at-teaching-pause', Boolean(barrier));
      const branches = this.rollout.branches;
      const skillLabel = branch !== 'all' ? this.branchLabel(branch) : branches.length > 1 ? 'Skills' : branches[0].label;
      this.phase.textContent = skillPhase ? skillLabel : atSwitch ? 'Switch' : 'Potential policy';
      const end = this.timeline.variant.endStep;
      this.readout.textContent = `${step} / ${end}`;
      this.readout.title = 'Episode step';
      this.slider.max = String(end);
      // While playing, glide() moves the thumb continuously; frame updates would make it jump.
      if (!this.playing || this.preparing) {
        this.slider.value = String(step);
        this.slider.style.setProperty('--progress', String(step / end));
      }
      this.slider.setAttribute('aria-valuetext', `Episode step ${step}, ${this.phase.textContent}`);
      this.slider.style.setProperty('--switch', String(this.rollout.switchStep / end));
      // White for the potential policy, then a band per skill, as in the video legend.
      const colors = branches.map(item => item.color);
      this.slider.style.setProperty('--skills', `linear-gradient(to bottom, ${colors.map((color, i) =>
        `${color} ${i / colors.length * 100}% ${(i + 1) / colors.length * 100}%`).join(', ')})`);
      if (this.playing) setIcon(this.playButton, 'pause', 'Pause');
      else if (step >= end) setIcon(this.playButton, 'replay', 'Replay');
      else if (barrier) setIcon(this.playButton, 'play', barrier.step === this.rollout.switchStep ? 'Play skills' : 'Continue');
      else setIcon(this.playButton, 'play', 'Play');
      if (this.message) {
        const plural = branches.length > 1 && branch === 'all';
        this.messageTitle.textContent = barrier?.title || (skillPhase ? (plural ? 'The skills' : branches.length > 1 ? this.branchLabel(branch) : 'The skill') : 'The potential empowerment policy');
        this.messageDetail.textContent = barrier?.detail || (skillPhase ? (plural || branches.length === 1 ? this.rollout.skillText : this.rollout.skillTextOne) : this.rollout.potentialText);
      }
      this.chipButtons?.forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.branch === branch)));
      // A clip may end on an annotated still (endPoster) instead of its last frame.
      const poster = barrier?.poster || (step >= end && !this.playing ? this.rollout.endPoster : null);
      this.hold.hidden = !poster;
      if (poster) {
        const suffix = this.key === 'craftax' && branch !== 'all' ? `-skill-${branch}` : '';
        const filename = poster.replace('.png', `${suffix}.png`);
        const url = new URL(this.baseUrl + filename, document.baseURI).href;
        if (this.hold.src !== url) this.hold.src = url;
      }
      if (this.potentialCard) {
        this.potentialCard.classList.toggle('active', !skillPhase);
        this.skillCard.classList.toggle('active', skillPhase);
      }
      this.drawOverlay();
      this.drawLaneLabels();
      if (this.pathSvg) this.drawPaths();
      if (this.chartSvg) this.drawChart();
    }

    drawLaneLabels() {
      const grid = this.key === 'craftax' && this.timeline.branch === 'all' && this.timeline.step > this.rollout.switchStep;
      this.laneLabels.hidden = !grid;
      if (!grid) return;
      this.laneLabels.replaceChildren(...this.rollout.branches.map((branch, lane) => {
        const label = element('span', 'rollout-lane-label');
        const swatch = element('span', 'rollout-swatch');
        swatch.style.background = branch.color;
        label.append(swatch, this.timeline.step > this.rollout.ends[lane] ? `${branch.label} ended` : branch.label);
        return label;
      }));
    }

    drawOverlay() {
      const svg = this.overlay;
      svg.replaceChildren();
      const switchStep = this.rollout.switchStep;
      if (this.key !== 'craftax' || this.timeline.step !== switchStep) return;
      // Craftax-Classic frames are 9 x 9 blocks: a 9 x 7 map over a 2-row HUD, player at (4, 3).
      // Each skill gets one of the four moves (up, right, down, left), assigned to best match
      // the direction it actually travels over the next 20 recorded steps.
      const moves = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const headings = this.rollout.branches.map((branch, lane) => {
        const path = this.rollout.paths[lane];
        const start = path[switchStep], later = path[Math.min(switchStep + 20, this.rollout.ends[lane])];
        const dx = later[0] - start[0], dy = later[1] - start[1], length = Math.hypot(dx, dy) || 1;
        return [dx / length, dy / length];
      });
      let best = null, bestScore = -Infinity;
      const permute = (prefix, rest) => {
        if (!rest.length) {
          const score = prefix.reduce((sum, move, lane) => sum + (headings[lane] ? headings[lane][0] * moves[move][0] + headings[lane][1] * moves[move][1] : 0), 0);
          if (score > bestScore) { bestScore = score; best = prefix; }
          return;
        }
        rest.forEach((move, i) => permute([...prefix, move], rest.filter((_, j) => j !== i)));
      };
      permute([], [0, 1, 2, 3].slice(0, headings.length));
      const selected = this.selectedBranches;
      const origin = [4.5, 3.5];
      this.rollout.branches.slice(0, 4).forEach((branch, lane) => {
        const [dx, dy] = moves[best[lane]];
        const from = [origin[0] + dx * 0.55, origin[1] + dy * 0.55], to = [origin[0] + dx * 1.75, origin[1] + dy * 1.75];
        // One arrow outline (shaft and head as a single polygon), stroked white underneath,
        // so the white border has the same thickness on every side.
        const head = 0.32, half = 0.065, wing = 0.19, side = [-dy, dx];
        const base = [to[0] - dx * head, to[1] - dy * head];
        const at = (point, offset) => `${(point[0] + side[0] * offset).toFixed(3)},${(point[1] + side[1] * offset).toFixed(3)}`;
        const outline = [at(from, half), at(base, half), at(base, wing), at(to, 0), at(base, -wing), at(base, -half), at(from, -half)].join(' ');
        const group = svgNode('g', { opacity: this.timeline.branch === 'all' || selected.includes(branch) ? 1 : 0.5 });
        group.append(svgNode('polygon', { points: outline, fill: '#fff', stroke: '#fff', 'stroke-width': 0.16, 'stroke-linejoin': 'round' }),
          svgNode('polygon', { points: outline, fill: branch.color }));
        svg.append(group);
      });
    }

    drawPaths() {
      const all = this.rollout.paths.flat().filter(Boolean);
      const objects = this.rollout.objectPaths;
      const isBlocks = this.key === 'builderbench';
      const isGrid = this.key === 'craftax';
      for (const path of objects) for (const sample of path) {
        if (isBlocks) all.push(...sample);
        else all.push(sample);
      }
      const xs = all.map(point => point[0]);
      const ys = all.map(point => point[1]);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      // Ant arenas use the walled arena the top-down camera frames (centered at 10, 10),
      // so the plot and the footage share geometry. Others fit their recorded extent.
      const arena = this.key === 'ant' || this.key === 'ant_soccer';
      const span = arena ? 24.4 : Math.max(xMax - xMin, yMax - yMin, isBlocks ? 0.1 : 1) * 1.15;
      const cx = arena ? 10 : (xMin + xMax) / 2, cy = arena ? 10 : (yMin + yMax) / 2;
      const box = { x: 1, y: 1, size: 298 };
      const scale = box.size / span;
      const x = value => box.x + (value - cx + span / 2) * scale;
      const y = value => isGrid ? box.y + (value - cy + span / 2) * scale : box.y + box.size - (value - cy + span / 2) * scale;
      const line = points => points.map((point, index) => `${index ? 'L' : 'M'}${x(point[0]).toFixed(2)},${y(point[1]).toFixed(2)}`).join(' ');
      const svg = this.pathSvg;
      svg.replaceChildren(svgNode('rect', { x: box.x, y: box.y, width: box.size, height: box.size, rx: 4, fill: '#f4f4f0', stroke: '#dddfd9' }));
      this.pathTitle.textContent = this.key === 'ant_soccer' ? 'Top view: agent (solid) and ball (dashed).' :
        isBlocks ? 'Top view: gripper (solid) and blocks (dashed).' :
        isGrid ? 'Top view: player path. Sprites mark where achievements were unlocked.' : 'Top view: agent path.';
      // Scale bar instead of unlabeled axes.
      const unit = isGrid ? 5 : [0.1, 0.25, 0.5, 1, 2, 5].find(length => length * scale >= 40) || 5;
      const barEnd = box.x + box.size - 12, barY = box.y + box.size - 14;
      svg.append(svgNode('path', { d: `M${barEnd - unit * scale},${barY - 4}V${barY}H${barEnd}V${barY - 4}`, stroke: '#8a9193', fill: 'none', 'stroke-width': 1.5 }),
        svgNode('text', { x: barEnd - unit * scale / 2, y: barY - 9, 'text-anchor': 'middle', class: 'plot-label plot-small' }, isGrid ? `${unit} cells` : `${unit} m`));
      const step = this.timeline.step;
      const switchStep = this.rollout.switchStep;
      const prefix = this.rollout.paths[0].slice(0, Math.min(step, switchStep) + 1);
      svg.append(svgNode('path', { d: line(prefix), stroke: '#2f3437', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      const selected = this.selectedBranches;
      const ordered = [...this.rollout.branches.filter(branch => !selected.includes(branch)), ...selected];
      for (const branch of ordered) {
        const active = selected.includes(branch);
        const lane = this.rollout.branches.indexOf(branch);
        const end = Math.min(step, this.rollout.ends[lane]);
        const points = this.rollout.paths[lane];
        const group = svgNode('g', { opacity: active ? 1 : 0.22 });
        if (step > switchStep) group.append(svgNode('path', { d: line(points.slice(switchStep, end + 1)),
          stroke: branch.color, 'stroke-width': 2.6, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        if (objects.length && step > switchStep) {
          const paths = isBlocks ? [0, 1, 2].map(index => objects[lane].map(sample => sample[index])) : [objects[lane]];
          for (const path of paths) {
            group.append(svgNode('path', { d: line(path.slice(switchStep, end + 1)),
              stroke: branch.color, 'stroke-width': 1.8, 'stroke-dasharray': '3 3', fill: 'none' }));
            const object = path[end];
            group.append(isBlocks ? svgNode('rect', { x: x(object[0]) - 4, y: y(object[1]) - 4, width: 8, height: 8, fill: branch.color, stroke: '#fff' }) :
              soccerBall(x(object[0]), y(object[1]), branch.color));
          }
        }
        const point = points[end];
        if (point && (active || step > switchStep)) group.append(svgNode('circle', { cx: x(point[0]), cy: y(point[1]), r: 4.5,
          fill: step > switchStep ? branch.color : '#2f3437', stroke: '#fff', 'stroke-width': 1.5 }));
        svg.append(group);
      }
      if (isGrid) {
        // Achievement sprites where each was first unlocked; shared-prefix unlocks drawn once.
        const seen = new Set();
        for (const event of this.rollout.events) {
          if (!event.icon || event.step > step) continue;
          const shared = event.step <= switchStep;
          const key = shared ? `${event.title}@${event.step}` : `${event.title}@${event.branch}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const lane = this.rollout.branches.findIndex(branch => branch.id === event.branch);
          const branch = this.rollout.branches[lane];
          const point = this.rollout.paths[lane][event.step];
          const active = shared || selected.includes(branch);
          const size = 15;
          const icon = svgNode('g', { opacity: active ? 1 : 0.35, transform: `translate(${(x(point[0]) - size / 2).toFixed(2)},${(y(point[1]) - size / 2).toFixed(2)})` });
          icon.append(svgNode('title', {}, `${event.title} · step ${event.step}${shared ? '' : ` · ${branch.label}`}`),
            svgNode('rect', { x: -1.5, y: -1.5, width: size + 3, height: size + 3, rx: 2.5, fill: '#fff', stroke: shared ? '#2f3437' : branch.color, 'stroke-width': 1.4 }));
          const image = svgNode('image', { width: size, height: size, preserveAspectRatio: 'xMidYMid meet', style: 'image-rendering: pixelated' });
          image.setAttribute('href', this.baseUrl + event.icon);
          icon.append(image);
          svg.append(icon);
        }
      }
      if (objects.length && step <= switchStep) {
        const shared = isBlocks ? [0, 1, 2].map(index => objects[0][Math.min(step, switchStep)][index]) : [objects[0][Math.min(step, switchStep)]];
        for (const object of shared) svg.append(isBlocks ?
          svgNode('rect', { x: x(object[0]) - 4, y: y(object[1]) - 4, width: 8, height: 8, fill: '#9aa1a3', stroke: '#fff' }) :
          soccerBall(x(object[0]), y(object[1]), '#2f3437'));
      }
    }

    drawChart() {
      const trace = this.rollout.trace;
      const selected = this.timeline.branch === 'all' ? -1 : this.rollout.branches.findIndex(branch => String(branch.id) === this.timeline.branch);
      const values = selected < 0 ? trace.mean : trace.values[selected];
      const finite = [...trace.mean, ...values].filter(value => Number.isFinite(value));
      const upperValues = trace.mean.map((value, i) => Number.isFinite(value) ? value + (trace.stderr[i] || 0) : 0);
      const ymax = Math.max(0.01, ...finite, ...upperValues) * 1.08;
      const maxStep = Math.max(...this.rollout.ends);
      // Draw in screen pixels so text and margins keep their size at any width.
      const width = Math.max(280, Math.round(this.chartSvg.getBoundingClientRect().width) || 720);
      const height = width < 520 ? 210 : 250;
      this.chartSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const left = 44, right = width - 12, top = 14, bottom = height - 54;
      const x = step => left + step / maxStep * (right - left);
      const y = value => bottom - value / ymax * (bottom - top);
      const svg = this.chartSvg;
      svg.replaceChildren();
      const definitions = svgNode('defs');
      const clip = svgNode('clipPath', { id: `${this.id}-chart-clip` });
      clip.append(svgNode('rect', { x: left, y: top - 4, width: right - left + 4, height: bottom - top + 4 }));
      definitions.append(clip);
      svg.append(definitions);
      const switchStep = this.rollout.switchStep;
      const prefixColor = trace.potentialColor || '#222';
      const gradientId = `${this.id}-trace-colors`;
      const gradient = svgNode('linearGradient', { id: gradientId, gradientUnits: 'userSpaceOnUse', x1: x(0), x2: x(maxStep), y1: 0, y2: 0 });
      gradient.append(svgNode('stop', { offset: 0, 'stop-color': prefixColor }),
        svgNode('stop', { offset: switchStep / maxStep, 'stop-color': prefixColor }));
      trace.colorSteps.forEach((step, i) => gradient.append(svgNode('stop', { offset: step / maxStep, 'stop-color': trace.colors[i] })));
      definitions.append(gradient);
      // Light horizontal grid and ticks.
      for (const ratio of [0, 0.5, 1]) {
        const value = ratio * ymax / 1.08;
        const yy = y(value);
        svg.append(svgNode('line', { x1: left, x2: right, y1: yy, y2: yy, stroke: ratio ? '#ecede9' : '#b8bdbb' }),
          svgNode('text', { x: left - 8, y: yy + 5, 'text-anchor': 'end', class: 'plot-label' }, value.toFixed(1)));
      }
      for (const step of [0, switchStep, maxStep]) {
        svg.append(svgNode('text', { x: x(step), y: bottom + 22, 'text-anchor': step === maxStep ? 'end' : step ? 'middle' : 'start', class: 'plot-label' }, String(step)));
      }
      svg.append(svgNode('text', { x: (left + right) / 2, y: bottom + 46, 'text-anchor': 'middle', class: 'plot-label' }, 'Episode step'),
        svgNode('line', { x1: x(switchStep), x2: x(switchStep), y1: top, y2: bottom, stroke: '#9aa0a2', 'stroke-dasharray': '4 4' }),
        svgNode('text', { x: x(switchStep) + 6, y: top + 12, class: 'plot-label plot-small' }, 'switch'));
      const visible = Math.min(this.timeline.step, maxStep);
      const series = (data, withBand) => {
        let path = '', drawing = false;
        const upper = [], lower = [];
        for (let i = 0; i < trace.steps.length; i++) {
          const step = trace.steps[i], value = data[i];
          if (step > visible) break;
          if (!Number.isFinite(value)) { drawing = false; continue; }
          path += `${drawing ? 'L' : 'M'}${x(step).toFixed(2)},${y(value).toFixed(2)} `;
          drawing = true;
          if (withBand) {
            upper.push([x(step), y(value + (trace.stderr[i] || 0))]);
            lower.push([x(step), y(value - (trace.stderr[i] || 0))]);
          }
        }
        const band = upper.length > 1 ? [...upper, ...lower.reverse()].map((point, i) => `${i ? 'L' : 'M'}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(' ') + 'Z' : '';
        return { path, band };
      };
      const clipPath = `url(#${this.id}-chart-clip)`;
      const mean = series(trace.mean, true);
      let color;
      if (selected < 0) {
        if (mean.band) svg.append(svgNode('path', { d: mean.band, fill: `url(#${gradientId})`, opacity: 0.16, 'clip-path': clipPath }));
        svg.append(svgNode('path', { d: mean.path, stroke: `url(#${gradientId})`, 'stroke-width': 2.6, fill: 'none', 'stroke-linejoin': 'round', 'clip-path': clipPath }));
        color = visible <= switchStep ? prefixColor : trace.colors[floorIndex(trace.colorSteps, visible)];
      } else {
        // A single branch in its identity color over the all-skill mean in gray.
        const branchColor = this.rollout.branches[selected].color;
        if (mean.band) svg.append(svgNode('path', { d: mean.band, fill: '#9aa0a2', opacity: 0.16, 'clip-path': clipPath }));
        svg.append(svgNode('path', { d: mean.path, stroke: '#a7adae', 'stroke-width': 1.6, fill: 'none', 'clip-path': clipPath }));
        const own = series(values, false);
        svg.append(svgNode('path', { d: own.path, stroke: visible <= switchStep ? prefixColor : branchColor, 'stroke-width': 2.6, fill: 'none', 'stroke-linejoin': 'round', 'clip-path': clipPath }));
        if (visible > switchStep) {
          const prefix = series(values.map((value, i) => trace.steps[i] <= switchStep ? value : NaN), false);
          svg.append(svgNode('path', { d: prefix.path, stroke: prefixColor, 'stroke-width': 2.6, fill: 'none', 'clip-path': clipPath }));
        }
        color = visible <= switchStep ? prefixColor : branchColor;
      }
      const index = floorIndex(trace.steps, visible), current = values[index];
      svg.append(svgNode('line', { x1: x(visible), x2: x(visible), y1: top, y2: bottom, stroke: '#5b6366', opacity: 0.35 }));
      if (Number.isFinite(current)) svg.append(svgNode('circle', { cx: x(visible), cy: y(Math.max(0, current)), r: 4.5, fill: color, stroke: '#fff', 'stroke-width': 1.5 }));
      this.chartTitle.textContent = 'Estimated potential empowerment (nats)';
      this.chartNote.textContent = selected < 0 ?
        'Mean ± standard error across the displayed four skills. Values after termination omitted.' :
        `${this.rollout.branches[selected].label} in color, with the mean ± standard error across the displayed four skills in gray. Values after termination omitted.`;
    }
  }

  function chooseAutoPlayer() {
    if (document.hidden || reducedMotion.matches) return;
    const candidates = players.filter(player => player.visible && !player.failed && !player.manualPause &&
      !player.timeline.barrier && player.timeline.step < player.timeline.variant.endStep);
    candidates.sort((a, b) => {
      const distance = player => Math.abs(player.stage.getBoundingClientRect().top + player.stage.clientHeight / 2 - innerHeight / 2);
      return distance(a) - distance(b);
    });
    const next = candidates[0];
    if (activePlayer && !activePlayer.visible) activePlayer.pause('viewport');
    if (next && (!activePlayer?.playing || !activePlayer.visible)) next.play();
  }

  function initialize() {
    const manifest = window.ROLLOUT_MANIFEST;
    if (!manifest) return;
    document.querySelectorAll('[data-rollout], [data-rollouts]').forEach(root => {
      const keys = (root.dataset.rollouts || root.dataset.rollout).split(',');
      if (keys.every(key => manifest.rollouts[key])) new RolloutPlayer(root, manifest);
    });
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          const player = entry.target.rolloutPlayer;
          player.visible = entry.isIntersecting && entry.intersectionRatio >= 0.3;
          if (!player.visible && player.playing) player.pause('viewport');
        });
        chooseAutoPlayer();
      }, { threshold: [0, 0.3, 0.6] });
      players.forEach(player => observer.observe(player.root));
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) players.forEach(player => player.pause('viewport'));
      else chooseAutoPlayer();
    });
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches) players.forEach(player => player.pause('viewport'));
      else chooseAutoPlayer();
    });
  }

  window.GuidedTimeline = GuidedTimeline;
  window.RolloutPlayer = RolloutPlayer;
  RolloutPlayer.instances = players;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
