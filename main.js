const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");
const statusPill = document.getElementById("status-pill");
const form = document.getElementById("config-form");
const multiplierInput = document.getElementById("multiplier");
const multiplierValue = document.getElementById("multiplier-value");
const startBtn = document.getElementById("start-btn");
const pauseBtn = document.getElementById("pause-btn");
const resetBtn = document.getElementById("reset-btn");

// Counter nodes - will be initialized after DOM is ready
let counterNodes = {
  circle: null,
  square: null,
  triangle: null,
};

// Initialize counter nodes once DOM is ready
function initCounterNodes() {
  const circleEl = document.querySelector('.counter-value[data-type="circle"]');
  const squareEl = document.querySelector('.counter-value[data-type="square"]');
  const triangleEl = document.querySelector('.counter-value[data-type="triangle"]');
  
  if (!circleEl || !squareEl || !triangleEl) {
    console.warn('Counter nodes not found, retrying...');
    // Retry after a short delay if elements aren't ready
    setTimeout(initCounterNodes, 10);
    return;
  }
  
  counterNodes = {
    circle: circleEl,
    square: squareEl,
    triangle: triangleEl,
  };
}

const CENTER = { x: canvas.width / 2, y: canvas.height / 2 };
const ARENA_RADIUS = Math.min(canvas.width, canvas.height) / 2 - 40;

const TYPE_CONFIG = {
  circle: {
    color: "#6dd3ff",
    speed: 140,
    hp: 55,
    damage: 9,
    range: 18,
    cooldown: 0.55,
    size: 10,
    label: "Circles dominate with speed.",
  },
  square: {
    color: "#ffc857",
    speed: 91,
    hp: 130,
    damage: 18,
    range: 22,
    cooldown: 1.2,
    size: 16,
    label: "Squares soak damage and hit hard.",
  },
  triangle: {
    color: "#ff6f91",
    speed: 90,
    hp: 85,
    damage: 7,
    range: 60,
    cooldown: 0.8,
    size: 14,
    preferred: { min: 40, max: 55 },
    label: "Triangles strike from afar.",
  },
};

let warriors = [];
let projectiles = [];
let hitEffects = [];
let running = false;
let animationFrameId = null;
let lastTimestamp = 0;
let winnerType = null; // Store the winner type for victory message

// Audio context for sound effects
let audioContext = null;
function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

class Warrior {
  constructor(type, x, y) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.config = TYPE_CONFIG[type];
    this.hp = this.config.hp;
    this.cooldown = 0;
    this.alive = true;
    this.heading = Math.random() * Math.PI * 2;
    this.evadeDirection = 0; // For triangles to dodge
    this.evadeTimer = 0; // Timer for evasive maneuvers
    this.lastHitDirX = 0; // For circles: direction of last melee attack
    this.lastHitDirY = 0;
    this.wantRetreat = 0; // Frames of retreat/sidestep behavior after a hit
  }

  distanceTo(other) {
    const dx = other.x - this.x;
    const dy = other.y - this.y;
    return Math.hypot(dx, dy);
  }

  findTarget(candidates) {
    let closest = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const enemy of candidates) {
      if (enemy === this || !enemy.alive || enemy.type === this.type) {
        continue;
      }
      const d = this.distanceTo(enemy);
      if (d < distance) {
        distance = d;
        closest = enemy;
      }
    }
    return closest;
  }

  takeDamage(amount) {
    this.hp -= amount;
    if (this.hp <= 0) {
      this.alive = false;
      playDeathSound(this.type);
    }
  }

  clampInsideArena() {
    const dx = this.x - CENTER.x;
    const dy = this.y - CENTER.y;
    const dist = Math.hypot(dx, dy);
    const maxDist = ARENA_RADIUS - this.config.size;
    if (dist > maxDist) {
      const scale = maxDist / dist;
      this.x = CENTER.x + dx * scale;
      this.y = CENTER.y + dy * scale;
    }
  }

  attemptAttack(target) {
    if (!target || !target.alive || this.cooldown > 0) {
      return;
    }
    const distance = this.distanceTo(target);
    if (this.type === "triangle") {
      if (distance <= this.config.range) {
        fireProjectile(this, target);
        this.cooldown = this.config.cooldown;
      }
      return;
    }

    // For melee units, check if we're close enough to connect a hit.
    // Use the larger of attack range and combined sizes so they can hit when touching.
    const minDistance = this.config.size + target.config.size;
    const meleeReach = Math.max(this.config.range, minDistance);
    if (distance <= meleeReach) {
      target.takeDamage(this.config.damage);
      this.cooldown = this.config.cooldown;
      spawnHitEffect(target.x, target.y);

      // Circles: remember attack direction and trigger brief retreat/sidestep
      if (this.type === "circle") {
        const attackDx = target.x - this.x;
        const attackDy = target.y - this.y;
        const attackDist = Math.hypot(attackDx, attackDy) || 1;
        this.lastHitDirX = attackDx / attackDist;
        this.lastHitDirY = attackDy / attackDist;
        // Retreat longer against squares so they clearly stick-and-move on tanks
        this.wantRetreat = target.type === "square" ? 0.8 : 0.4;
      }
    }
  }

  update(dt, everyone) {
    if (!this.alive) {
      return;
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    // Decay any post-hit retreat/sidestep behavior
    if (this.wantRetreat > 0) {
      this.wantRetreat = Math.max(0, this.wantRetreat - dt);
    }
    const target = this.findTarget(everyone);
    if (!target) {
      return;
    }

    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy) || 1;
    
    // Movement rules:
    // - Triangles: kite — back away if too close, chase a bit if too far, hold when in a good band.
    // - Melee (circles/squares): move until they are almost colliding (based on sizes).
    const attackRange = this.type === "triangle" ? this.config.range : 0;
    const minDistance = this.config.size + target.config.size;
    let shouldMove;
    if (this.type === "triangle") {
      const pref = this.config.preferred;
      const threatRadius = pref.min * 1.4;
      // Strong kiting rules for triangles:
      // - If any melee threat is inside threatRadius, we should be moving away.
      // - If target is beyond attack range, move in.
      // - Otherwise, hold and only dodge.
      shouldMove = dist < threatRadius || dist > attackRange;
    } else {
      shouldMove = dist > minDistance;
      // Circles: if we're in a post-hit retreat window, always move (even if already in melee range)
      if (this.type === "circle" && this.wantRetreat > 0) {
        shouldMove = true;
      }
    }
    
    let dirX = dx / dist;
    let dirY = dy / dist;
    let desiredHeading = Math.atan2(dirY, dirX);

    if (this.type === "triangle") {
      // Check for nearby threats (enemies and projectiles) for evasive maneuvers
      let evadeX = 0;
      let evadeY = 0;
      const evadeRadius = 50; // Distance to start evading
      
      // Check for nearby enemies
      for (const enemy of everyone) {
        if (!enemy.alive || enemy.type === this.type || enemy === this) continue;
        const enemyDx = enemy.x - this.x;
        const enemyDy = enemy.y - this.y;
        const enemyDist = Math.hypot(enemyDx, enemyDy);
        if (enemyDist < evadeRadius && enemyDist > 0) {
          // Evade away from enemy
          const evadeStrength = (evadeRadius - enemyDist) / evadeRadius;
          evadeX -= (enemyDx / enemyDist) * evadeStrength;
          evadeY -= (enemyDy / enemyDist) * evadeStrength;
        }
      }
      
      // Check for nearby projectiles
      for (const projectile of projectiles) {
        if (!projectile.alive || projectile.ownerType === this.type) continue;
        const projDx = projectile.x - this.x;
        const projDy = projectile.y - this.y;
        const projDist = Math.hypot(projDx, projDy);
        if (projDist < evadeRadius && projDist > 0) {
          // Evade away from projectile
          const evadeStrength = (evadeRadius - projDist) / evadeRadius;
          evadeX -= (projDx / projDist) * evadeStrength * 1.5; // More urgent evasion from projectiles
          evadeY -= (projDy / projDist) * evadeStrength * 1.5;
        }
      }
      
      // Base movement: if too close, always back directly away from the target.
      const pref = this.config.preferred;
      if (dist < pref.min) {
        dirX = -dx / dist;
        dirY = -dy / dist;
      } else if (dist <= pref.max && shouldMove) {
        // Strafe by rotating vector 90 degrees when in band but still adjusting
        const temp = dirX;
        dirX = -dirY;
        dirY = temp;
      }
      
      // Apply evasive maneuvers on top of base movement
      if (Math.abs(evadeX) > 0.1 || Math.abs(evadeY) > 0.1) {
        const evadeMag = Math.hypot(evadeX, evadeY);
        evadeX /= evadeMag;
        evadeY /= evadeMag;
        // Blend evasion with movement (70% evasion, 30% normal movement)
        dirX = dirX * 0.3 + evadeX * 0.7;
        dirY = dirY * 0.3 + evadeY * 0.7;
        const blendMag = Math.hypot(dirX, dirY);
        if (blendMag > 0) {
          dirX /= blendMag;
          dirY /= blendMag;
        }
      }
      
      desiredHeading = Math.atan2(dirY, dirX);
    }

    // Circles: stick-and-move behavior (flank and back-step after hits)
    if (this.type === "circle" && this.wantRetreat > 0) {
      // Retreat slightly opposite of last hit direction, plus a small lateral offset
      let backX = -this.lastHitDirX;
      let backY = -this.lastHitDirY;
      // Perpendicular vector for lateral movement
      let sideX = -this.lastHitDirY;
      let sideY = this.lastHitDirX;
      // Mix back-step and sidestep (60% back, 40% side)
      dirX = backX * 0.6 + sideX * 0.4;
      dirY = backY * 0.6 + sideY * 0.4;
      const mag = Math.hypot(dirX, dirY) || 1;
      dirX /= mag;
      dirY /= mag;
      desiredHeading = Math.atan2(dirY, dirX);
    }

    // Smooth heading changes for triangles to prevent glitchy turning
    if (this.type === "triangle") {
      let angleDiff = desiredHeading - this.heading;
      // Normalize angle difference to [-PI, PI]
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      
      const turnSpeed = 3.0; // radians per second
      const maxTurn = turnSpeed * dt;
      if (Math.abs(angleDiff) > maxTurn) {
        this.heading += Math.sign(angleDiff) * maxTurn;
      } else {
        this.heading = desiredHeading;
      }
    } else {
      this.heading = desiredHeading;
    }

    // Only move if we're not in attack range
    if (shouldMove) {
      const speed = this.config.speed * dt;
      this.x += dirX * speed;
      this.y += dirY * speed;
      this.clampInsideArena();
    }
    
    this.attemptAttack(target);
  }
}

class Projectile {
  constructor(owner, target) {
    this.ownerType = owner.type;
    this.damage = owner.config.damage;
    this.x = owner.x;
    this.y = owner.y;
    const dx = target.x - owner.x;
    const dy = target.y - owner.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = 260;
    this.vx = (dx / dist) * speed;
    this.vy = (dy / dist) * speed;
    this.life = 0;
    this.maxLife = 3.5;
    this.alive = true;
    this.radius = 4;
  }

  update(dt) {
    this.life += dt;
    if (this.life >= this.maxLife) {
      this.alive = false;
      return;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const dx = this.x - CENTER.x;
    const dy = this.y - CENTER.y;
    if (Math.hypot(dx, dy) >= ARENA_RADIUS) {
      this.alive = false;
    }

    for (const enemy of warriors) {
      if (!enemy.alive || enemy.type === this.ownerType) {
        continue;
      }
      const dist = Math.hypot(enemy.x - this.x, enemy.y - this.y);
      if (dist <= enemy.config.size + this.radius) {
        enemy.takeDamage(this.damage);
        // Spawn subtle hit effect at impact point
        spawnHitEffect(this.x, this.y);
        this.alive = false;
        break;
      }
    }
  }
}

function fireProjectile(shooter, target) {
  projectiles.push(new Projectile(shooter, target));
}

function randomPoint() {
  const theta = Math.random() * Math.PI * 2;
  const radius = Math.random() ** 0.5 * (ARENA_RADIUS - 50);
  return {
    x: CENTER.x + Math.cos(theta) * radius,
    y: CENTER.y + Math.sin(theta) * radius,
  };
}

function isPositionValid(x, y, existingWarriors, minDistance) {
  for (const warrior of existingWarriors) {
    const dx = warrior.x - x;
    const dy = warrior.y - y;
    if (Math.hypot(dx, dy) < minDistance) {
      return false;
    }
  }
  return true;
}

function seedWarriors(counts) {
  warriors = [];
  projectiles = [];
  const minSpacing = 25; // Minimum distance between warriors when spawning
  for (const type of Object.keys(TYPE_CONFIG)) {
    const amount = counts[type] ?? 0;
    for (let i = 0; i < amount; i += 1) {
      let attempts = 0;
      let point;
      do {
        point = randomPoint();
        attempts++;
      } while (!isPositionValid(point.x, point.y, warriors, minSpacing) && attempts < 100);
      warriors.push(new Warrior(type, point.x, point.y));
    }
  }
}

function collectCounts() {
  const data = new FormData(form);
  const multiplier = parseFloat(multiplierInput.value);
  const counts = {};
  for (const type of Object.keys(TYPE_CONFIG)) {
    const base = Number(data.get(type)) || 0;
    counts[type] = Math.max(0, Math.round(base * multiplier));
  }
  return counts;
}

function clearArena() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(CENTER.x, CENTER.y);
  const gradient = ctx.createRadialGradient(0, 0, ARENA_RADIUS * 0.05, 0, 0, ARENA_RADIUS);
  gradient.addColorStop(0, "rgba(19,27,48,0.8)");
  gradient.addColorStop(1, "rgba(4,5,10,0.9)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, ARENA_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.setLineDash([10, 12]);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.stroke();
  ctx.restore();
}

function playDeathSound(type) {
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    
    // Different frequencies and characteristics for each type
    let frequency, duration, attackTime, decayTime;
    
    switch (type) {
      case "circle":
        // Higher pitch, quick "pop" or "zap" sound
        frequency = 600 + Math.random() * 200;
        duration = 0.15;
        attackTime = 0.01;
        decayTime = 0.14;
        oscillator.type = "sine";
        break;
      case "square":
        // Lower pitch, deeper "thud" or "crunch" sound
        frequency = 150 + Math.random() * 100;
        duration = 0.25;
        attackTime = 0.02;
        decayTime = 0.23;
        oscillator.type = "sawtooth";
        break;
      case "triangle":
        // Medium pitch, "ping" or "chime" sound
        frequency = 400 + Math.random() * 150;
        duration = 0.2;
        attackTime = 0.01;
        decayTime = 0.19;
        oscillator.type = "sine";
        break;
      default:
        frequency = 300;
        duration = 0.15;
        attackTime = 0.01;
        decayTime = 0.14;
        oscillator.type = "sine";
    }
    
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    
    // Envelope: quick attack, then decay
    const now = ctx.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.15, now + attackTime);
    gainNode.gain.linearRampToValueAtTime(0, now + attackTime + decayTime);
    
    oscillator.start(now);
    oscillator.stop(now + duration);
  } catch (e) {
    // Silently fail if audio context creation fails (e.g., user interaction required)
    console.debug("Audio context not available:", e);
  }
}

function spawnHitEffect(x, y) {
  hitEffects.push({
    x,
    y,
    life: 0,
    maxLife: 0.25 + Math.random() * 0.1,
    size: 12 + Math.random() * 8,
    rotation: Math.random() * Math.PI,
  });
}

function updateHitEffects(dt) {
  hitEffects.forEach((fx) => {
    fx.life += dt;
  });
  hitEffects = hitEffects.filter((fx) => fx.life < fx.maxLife);
}

function drawHitEffects() {
  if (!hitEffects.length) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  for (const fx of hitEffects) {
    const t = fx.life / fx.maxLife;
    const alpha = 1 - t;
    const size = fx.size * (0.7 + 0.3 * t);
    ctx.globalAlpha = alpha;
    ctx.translate(fx.x, fx.y);
    ctx.rotate(fx.rotation);
    // Simple 4-point star (like a sparkle)
    ctx.beginPath();
    ctx.moveTo(-size, 0);
    ctx.lineTo(size, 0);
    ctx.moveTo(0, -size * 0.6);
    ctx.lineTo(0, size * 0.6);
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset transform
  }
  ctx.restore();
}

function drawVictoryMessage() {
  if (!winnerType) return;
  
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 48px Inter, system-ui, sans-serif";
  ctx.fillStyle = TYPE_CONFIG[winnerType].color;
  
  const typeName = capitalize(winnerType) + (winnerType === "triangle" ? "s" : "s");
  ctx.fillText(`${typeName} win!`, CENTER.x, CENTER.y);
  ctx.restore();
}

function drawWarrior(warrior) {
  ctx.save();
  ctx.translate(warrior.x, warrior.y);
  ctx.fillStyle = warrior.config.color;
  switch (warrior.type) {
    case "circle":
      ctx.beginPath();
      ctx.arc(0, 0, warrior.config.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "square":
      ctx.rotate(warrior.heading * 0.2);
      const size = warrior.config.size;
      ctx.fillRect(-size, -size, size * 2, size * 2);
      break;
    case "triangle":
      ctx.rotate(warrior.heading);
      ctx.beginPath();
      const s = warrior.config.size * 1.2;
      ctx.moveTo(s, 0);
      ctx.lineTo(-s * 0.8, s * 0.75);
      ctx.lineTo(-s * 0.8, -s * 0.75);
      ctx.closePath();
      ctx.fill();
      break;
    default:
      break;
  }

  // health bar
  const healthWidth = 26;
  const healthHeight = 4;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(-healthWidth / 2, -warrior.config.size - 10, healthWidth, healthHeight);
  const hpRatio = Math.max(0, warrior.hp / warrior.config.hp);
  ctx.fillStyle = "#4cffaa";
  ctx.fillRect(
    -healthWidth / 2,
    -warrior.config.size - 10,
    healthWidth * hpRatio,
    healthHeight
  );
  ctx.restore();
}

function drawProjectiles() {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  for (const projectile of projectiles) {
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function updateStats() {
  const aliveCounts = { circle: 0, square: 0, triangle: 0 };
  for (const warrior of warriors) {
    if (warrior.alive) {
      aliveCounts[warrior.type] += 1;
    }
  }
  for (const type of Object.keys(aliveCounts)) {
    let node = counterNodes[type];
    // Fallback: try to find the element if it's not initialized
    if (!node) {
      node = document.querySelector(`.counter-value[data-type="${type}"]`);
      if (node) {
        counterNodes[type] = node;
      } else {
        // Element doesn't exist yet, skip this update
        continue;
      }
    }
    // Double-check node is valid before setting textContent
    if (node && node.nodeType === 1 && typeof node.textContent !== 'undefined') {
      try {
        node.textContent = aliveCounts[type].toString();
      } catch (e) {
        console.warn(`Failed to update counter for ${type}:`, e);
        // Clear the cached node if it's invalid
        counterNodes[type] = null;
      }
    }
  }
  return aliveCounts;
}

function determineVictor(aliveCounts) {
  const livingTypes = Object.entries(aliveCounts).filter(([, count]) => count > 0);
  if (livingTypes.length <= 1) {
    if (livingTypes.length === 0) {
      setStatus("All units eliminated", "muted");
      winnerType = null;
    } else {
      const [type] = livingTypes[0];
      setStatus(`${capitalize(type)} dominate`, type);
      winnerType = type; // Store winner for victory message
    }
    return true;
  }
  return false;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function setStatus(text, tone = "neutral") {
  statusPill.textContent = text;
  const toneColors = {
    neutral: "rgba(255,255,255,0.3)",
    circle: TYPE_CONFIG.circle.color,
    square: TYPE_CONFIG.square.color,
    triangle: TYPE_CONFIG.triangle.color,
    muted: "rgba(255,255,255,0.3)",
    running: "#4cffaa",
    paused: "#ffb347",
  };
  statusPill.style.borderColor = toneColors[tone] ?? toneColors.neutral;
  statusPill.style.color = toneColors[tone] ?? toneColors.neutral;
}

function update(timestamp) {
  if (!running) {
    return;
  }
  const delta = (timestamp - lastTimestamp) / 1000 || 0;
  lastTimestamp = timestamp;

  for (const warrior of warriors) {
    warrior.update(delta, warriors);
  }
  projectiles.forEach((projectile) => projectile.update(delta));
  projectiles = projectiles.filter((projectile) => projectile.alive);
  warriors = warriors.filter((warrior) => warrior.alive);
  updateHitEffects(delta);

  clearArena();
  drawProjectiles();
  warriors.forEach(drawWarrior);
  drawHitEffects();

  const aliveCounts = updateStats();
  if (determineVictor(aliveCounts)) {
    // Draw victory message before stopping
    drawVictoryMessage();
    stopAnimation();
    return;
  }

  animationFrameId = requestAnimationFrame(update);
}

function stopAnimation() {
  running = false;
  pauseBtn.disabled = true;
  startBtn.disabled = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  // Redraw the final frame with victory message if there's a winner
  if (winnerType) {
    clearArena();
    drawProjectiles();
    warriors.forEach(drawWarrior);
    drawHitEffects();
    drawVictoryMessage();
  }
}

function startBattle() {
  const counts = collectCounts();
  seedWarriors(counts);
  updateStats();
  clearArena();
  warriors.forEach(drawWarrior);

  lastTimestamp = performance.now();
  running = true;
  animationFrameId = requestAnimationFrame(update);
  startBtn.disabled = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = "Pause";
  setStatus("Battle running", "running");
}

function togglePause() {
  if (!running && animationFrameId === null && warriors.length === 0) {
    return;
  }

  if (running) {
    running = false;
    pauseBtn.textContent = "Resume";
    setStatus("Paused", "paused");
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  } else {
    running = true;
    lastTimestamp = performance.now();
    animationFrameId = requestAnimationFrame(update);
    pauseBtn.textContent = "Pause";
    setStatus("Battle running", "running");
  }
}

function resetArena() {
  stopAnimation();
  warriors = [];
  projectiles = [];
  winnerType = null; // Reset winner
  clearArena();
  updateStats();
  pauseBtn.textContent = "Pause";
  setStatus("Setup", "neutral");
}

function handleResize() {
  // Keep the canvas square while respecting wrapper width
  const wrapper = canvas.parentElement;
  const size = Math.min(wrapper.clientWidth - 20, window.innerHeight - 280);
  if (size > 300) {
    canvas.style.height = `${size}px`;
  }
}

multiplierInput.addEventListener("input", () => {
  multiplierValue.textContent = `${Number(multiplierInput.value)}×`;
});

startBtn.addEventListener("click", startBattle);
pauseBtn.addEventListener("click", togglePause);
resetBtn.addEventListener("click", resetArena);
window.addEventListener("resize", handleResize);

// Initialize counter nodes when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initCounterNodes();
    resetArena();
    multiplierValue.textContent = "1×";
    handleResize();
  });
} else {
  initCounterNodes();
  // Initial paint
  resetArena();
  multiplierValue.textContent = "1×";
  handleResize();
}

