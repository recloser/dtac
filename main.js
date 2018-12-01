const PriorityQueue = require("js-priority-queue");
const {Keys} = require("./keys.js");
const {Maps} = require("./maps.js");
const {degToRad, radToDeg, clamp} = THREE.Math;

const DEV = false;
const OPTIMIZE_WORLD = !DEV;
const TILE_X = 1.0, TILE_Y = 0.3, TILE_Z = 1.0;
const SIDE_PLAYER = 0, SIDE_AI = 1;
let g_CurrentSide = SIDE_PLAYER;

let g_GotRedCard = false;

function byId(id) { return document.getElementById(id); }

class DTDoomSound {
  constructor(wadres, name) {
    let wad = wadres.wadjs;
    let idx = wad.getLumpIndexByName(name.toUpperCase())
    let lump = wad.getLump(idx);

    let dv = new DataView(lump);
    let fmt = dv.getUint16(0, true);
    if (fmt !== 3) throw `Invalid fmt: expected 3, got ${fmt}`;
    this.sampleRate = dv.getUint16(2, true);
    this.sampleCount = dv.getUint32(4, true);
    this.samples = new Uint8Array(this.sampleCount);
    for (let i = 0; i < this.sampleCount; i++) {
      this.samples[i] = dv.getUint8(8 + i) - 128;
    }
  }

  play() {
    let player = new PCMPlayer({
      encoding: '8bitInt',
      channels: 1,
      sampleRate: this.sampleRate,
      flushingTime: 50000,
    });
    player.volume(0.05);
    player.feed(this.samples);
    player.flush();
    setTimeout(() => {
        player.destroy();
      },
      (this.samples.length / this.sampleRate) * 1000 + 300
    )
  }
}

function choose(x) {
  let y = x;
  if (arguments.length > 1) y = arguments;
  return y[(Math.random() * y.length) | 0]
}

function almostEqual(a, b, eps=0.001) {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps
}

function randomBetween(min, maxExclusive) {
  return min + Math.random() * (maxExclusive - min);
}

function swapRemove(array, thing) {
  let idx = array.indexOf(thing);
  if (idx == -1) return;

  array[idx] = array[array.length-1];
  array.pop();
}

function swapRemoveAt(array, idx) {
  let item = array[idx];
  let unused;
  array[idx] = array[array.length-1];
  array.pop();
  return item;
}

function toScreenspace(sp) {
  let widthHalf = 0.5 * g_Renderer.context.canvas.width;
  let heightHalf = 0.5 * g_Renderer.context.canvas.height;
  sp.project(g_MainCamera);
  sp.x = sp.x * widthHalf + widthHalf;
  sp.y = -sp.y * heightHalf + heightHalf;
  return sp;
}

let g_DamagePopups = [];
let g_DamagePopupOffset = 0;

function updateDamagePopups(dt) {
  for (let popup of g_DamagePopups) {
    if (updateDamagePopup(popup, dt)) {
      swapRemove(g_DamagePopups, popup);
      popup.el.remove();
    }
  }
}

function updateDamagePopup(popup, dt) {
  popup.time += dt;
  let {el, pos, time} = popup;
  pos.y += TILE_Y * dt;
  let sp = toScreenspace(pos.clone());
  el.style.left = sp.x + "px";
  el.style.top = sp.y + "px";
  g_DamagePopupOffset = Math.max(g_DamagePopupOffset - dt, 0.0)
  return time > 1.0;
}

function makeDamagePopup(actor, position, damage) {
  let pos = position.clone();
  pos.x += randomBetween(-0.2, 0.2);
  pos.y += randomBetween(0.0, 0.2) + g_DamagePopupOffset;
  // g_DamagePopupOffset += 0.24;
  let last;
  if ((last = g_DamagePopups[g_DamagePopups.length - 1]) && last.actor == actor) {
    last.damage += damage;
    last.el.innerText = (last.damage > 0 ? "+" : "") + last.damage;
    last.time -= 0.1;
    return;
  }
  let el = document.createElement("span");
  el.className = "DamageNumber";
  let popup = {el, pos, actor, damage, time: 0};
  updateDamagePopup(popup, 0);
  document.body.appendChild(el);
  el.innerText = (damage > 0 ? "+" : "") + damage;
  g_DamagePopups.push(popup)
}

const BASE_WAD = "freedoom2.wad";
let g_Renderer;
let g_World;
let g_MainCamera;
let g_MainCameraControls, g_MainCameraControlsZoomChanged;
let g_CurrentAction;

const Resources = {
  wads: {},

  get(names) {
    let wadres;
    for (let wadname of names) {
      if (wadres = Resources.wads[wadname]) return wadres;
    }
  },

  loadWadFromURL: function(url, as) {
    if (as === undefined) {
      as = url.split("/")
      as = as[as.length-1]
    }

    as = as.toLowerCase();

    let wadLocal = Object.create(Wad); // Create a new WAD object to load our file into
    let that = this;

    return new Promise(function(resolve, reject) {
      let loadingEl = document.querySelector(".WadLoadingInfo");
      let i = 0;
      let dots = [".", "..", "..."];
      loadingEl.innerText = `Loading [${as}]${dots[i++ % dots.length]}`;
      wadLocal.onProgress = function() {
        console.info("Loading [" + as + "]...");
        loadingEl.innerText = `Loading [${as}]${dots[i++ % dots.length]}`;
      }
      wadLocal.onLoad = function() {
        window.wad = wadLocal; // write to global because wadjs is buggy
        loadingEl.innerText = `Loaded [${as}]!`;
        if (wadLocal.errormsg) {
          loadingEl.innerText = "Couldn't load WAD: " + wadLocal.errormsg;
          reject(wadLocal.errormsg);
        } else {
          setTimeout(function() {
            resolve(that.wads[as] = new DTWadResource(wadLocal));
          }, 1)
        }
      }
      wadLocal.loadURL(url)
    });
  }
}

function reallyStart() {
  initActorDefs();
  initWeaponDefs();
  initTileModelDefs();

  g_World = new DTWorld();
  let pos;
  for (let actor of g_World.actors) {
    actor.visibilityCheck()
    if (!pos && actor.side == SIDE_PLAYER) { pos = actor.object.position; break}
  }
  if (!pos) pos = new THREE.Vector3();
  g_MainCamera = new THREE.PerspectiveCamera( 20, window.innerWidth / window.innerHeight, 0.1, 1000 );
  // g_MainCamera.lookAt(pos);
  g_MainCameraControls = new THREE.MapControls( g_MainCamera, g_Renderer.context.canvas );
  g_MainCameraControls.minPolarAngle = degToRad(30);
  g_MainCameraControls.maxPolarAngle = degToRad(85);
  // g_MainCameraControls.enableDamping = true;
  // g_MainCameraControls.dampingFactor = 0.20;
  g_MainCamera.position.set(pos.x - 18, pos.y + 21, pos.z - 18);
  g_MainCameraControls.target.set(pos.x, pos.y, pos.z);
  g_MainCameraControls.onBeforeUpdate = function() {
    if (g_MainCameraControls._changedZoom()) g_MainCameraControlsZoomChanged = true;
  }
  // g_MainCameraControls = new THREE.OrbitControls( g_MainCamera );
  moveEditModeGrid(0);
  toggleMode(PLAY_MODE);

  let wad = Resources.wads[BASE_WAD].wadjs;
  let idx = wad.getLumpIndexByName("D_ULTIMA");
  let typ = wad.detectLumpType(idx);
  let data = wad.getLump(idx);
  let mid;
  if (typ == MUS) mid = mus2midi(data);
  else mid = data;
  let midblob = URL.createObjectURL(new Blob([mid]));
  function playMusic() {
    MIDIjs.play(midblob);
    MIDIjs.set_volume(0.1);
    setTimeout(playMusic, 326000)
  }
  playMusic();

  mainLoop();
}

function setErrorMsg(msgstr) {
  let el = document.querySelector(".ErrorMessage")
  if (el) {
    el.classList.remove("NoDisplay")
    let msg = el.querySelector(".MessageText");
    if (msg) {
      msg.innerText = "WebGL error: " + msgstr;
    }
  }
}

function start() {
  Resources.loadWadFromURL(BASE_WAD).then(
    function() {
      // return Resources.loadWadFromURL("doom.wad");
      return true;
    },
    function() {
      let err = `Couldn't load base wad! ( + ${BASE_WAD} + )`;
      console.error(err);
      document.body.appendChild(err);
    }
  )
  .then(
    function() {
      let renderer;
      try {
        renderer = g_Renderer = new THREE.WebGLRenderer();
        renderer.context.canvas.classList.add("DTCanvas");
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : error + "");
        throw error;
      }

      window.addEventListener( 'resize', onWindowResize, false );

      function onWindowResize(){
        if (g_MainCamera) {
          g_MainCamera.aspect = window.innerWidth / window.innerHeight;
          g_MainCamera.updateProjectionMatrix();
        }

        renderer.setSize( window.innerWidth, window.innerHeight );
      }

      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap; // default THREE.PCFShadowMap
      document.body.appendChild( renderer.domElement );

      document.querySelector(".WadDropZone").onclick = e => {
        e.stopPropagation();
      };
      document.querySelector(".WadDropZone .FileInput").addEventListener('change', (e) => {
        document.querySelector(".StartText").classList.add("NoDisplay")
        e.preventDefault();
        let i = 0;
        // let fs = e.target.files[0];
        let f = e.target.files[0];
        function loadNext() {
          if (true || i < fs.length) {
            console.log('... file[' + i + '].name = ' + f.name);
            let url = URL.createObjectURL(f);
            let promise = Resources.loadWadFromURL(url, f.name);
            promise.finally(function() {
              document.querySelector(".StartText").classList.remove("NoDisplay")
            });
            i += 1;
          }
        }
        loadNext();
      });

      document.querySelector(".StartText").classList.remove("NoDisplay");
      document.body.onclick = (e) => {
        if (g_Mode == MAIN_MENU_MODE &&
            !document.querySelector(".StartText").classList.contains("NoDisplay")) {
          reallyStart();
        }
      };
    },
    function() {
      let err = "Couldn't load base wad! (" + BASE_WAD + ")";
      console.error(err);
      setErrorMsg(err);
    }
  );
}
start();

class DTWadResource {
  constructor(wadjs) {
    this.wadjs = wadjs;
    this.graphics = {};
    this.sprites = {};
    this.sounds = {};
  }

  getSound(name) {
    let s = this.sounds[name];
    if (!s) {
      s = this.sounds[name] = new DTDoomSound(this, name);
    }

    return s;
  }

  getGraphic(name) {
    let f = this.graphics[name];
    if (!f) {
      f = this.graphics[name] = new DTDoomGraphic(this, name);
    }

    return f;
  }

  getSprite(name, frame) {
    let s = this.sprites[name];
    if (!s) {
      s = this.sprites[name] = new DTDoomSprite(this, name);
    }

    if (frame !== undefined) return s.getByFrame(frame);
    return s;
  }
}

class DTDoomSpriteFrame {
  constructor(wadres, spriteName, frameName) {
    this.wadres = wadres;
    this.bydir = loadSpriteFromWad(wadres.wadjs, spriteName, frameName);
  }
}

class DTDoomSprite {
  constructor(wadres, name) {
    this.wadres = wadres;
    this.name = name;
    this.frames = {};
  }

  getByFrame(frame) {
    let f = this.frames[frame];
    if (!f) {
      f = this.frames[frame] = new DTDoomSpriteFrame(this.wadres, this.name, frame);
    }

    return f;
  }
}

class EventSource {
  constructor() {
    this.listeners = [];
  }

  on(eventName, listener, once=false) {
    this.listeners.push({
      eventName: eventName,
      cb: listener,
      once: once
    })
  }

  disable(listener) {
    for (let i = 0; i < this.listeners.length; i++) {
      let l = this.listeners[i];
      if (l.cb == listener) {
        swapRemoveAt(this.listeners, i);
      }
    }
  }

  fire(eventName) {
    for (let l of this.listeners) {
      if (l.eventName == eventName) {
        l.cb(eventName);
        if (l.once) {
          this.disable(l.cb)
        }
      }
    }
  }
}

class DTDoomSpriteAnim {
  constructor(name, parsedAnim) {
    this.name = name;
    this.parsed = parsedAnim;
    this.dtAccum = 0;
    this.currentFrameNumber = 0;
    this._finished = false;
    this.events = new EventSource();
  }

  start() {
    this._finished = false;
    this.changeToFrame(0);
  }

  changeToFrame(frameNumber) {
    this.currentFrameNumber = frameNumber;
    let {frame, time, animEvent} = this.parsed[this.currentFrameNumber];
    this.frame = frame;
    this.ticsToGo = time;
    if (animEvent) {
      this.events.fire(animEvent);
    }
  }

  isFinished() {
    return this._finished;
  }

  advance(dt) {
    if (this.ticsToGo == -1) return;
    const TIC = 1.0/35.0;
    this.dtAccum += dt;
    while(this.dtAccum >= TIC) {
      this.dtAccum -= TIC;
      this.ticsToGo -= 1;
      if (this.ticsToGo == 0) {
        let nf = this.currentFrameNumber + 1;
        if (nf >= this.parsed.length) {
          this._finished = true;
          this.events.fire("finished");
        }
        this.changeToFrame(nf % this.parsed.length);
      }
    }
  }
}

class DTDoomGraphic {
  constructor(wadres, flatname) {
    let wad = wadres.wadjs;
    let idx = wad.getLumpIndexByName(flatname);
    let type = wad.detectLumpType(idx) ;
    let flat = type == "flat" ? Object.create(Flat) : Object.create(Graphic);
    let flatLump = wad.getLump(idx);;
    flat.load(flatLump);
    let c = flat.toCanvas(wad);
    let tx = new THREE.CanvasTexture(c);
    tx.wrapS = THREE.RepeatWrapping;
    tx.wrapT = THREE.RepeatWrapping;
    tx.anisotropy = g_Renderer.getMaxAnisotropy();
    tx.magFilter = THREE.NearestFilter;
    tx.needsUpdate = true;
    this.texture = tx;
  }
}

function texMat(textureName) {
  return new THREE.MeshLambertMaterial({
    map: Resources.wads[BASE_WAD].getGraphic(textureName).texture,
    side: THREE.DoubleSide,
  })
}

const NORTH = 0, EAST = 1, SOUTH = 2, WEST = 3, MAX_DIR = WEST;
const ROT0 = 0, ROT90 = 1, ROT180 = 2, ROT270 = 3, MAX_ROT = ROT270;
function ROTtoRads(rot) {
  switch(rot) {
    case ROT0: return degToRad(0);
    case ROT90: return degToRad(-90);
    case ROT180: return degToRad(-180);
    case ROT270: return degToRad(-270);
    default: throw "Invalid rot: " + rot;
  }
}

function oppositeDir(dir) {
  switch(dir) {
    case EAST: return WEST;
    case WEST: return EAST;
    case NORTH: return SOUTH;
    case SOUTH: return NORTH;
    default: throw "Invalid dir " + dir;
  }
}

function rotDir(rot, dir) {
  if (rot < ROT0 || rot > MAX_ROT) throw "Invalid rot " + rot;
  if (dir < NORTH || dir > MAX_DIR) throw "Invalid dir " + dir;
  dir += rot;
  return dir % (MAX_DIR+1);
}

function Box(
  width, height, depth, {
    xs = 1.0,
    xt = 1.0,
    ys = 1.0,
    yt = 1.0,
    zs = 1.0,
    zt = 1.0,

  } = {})
{
  let b = new THREE.Geometry();
  let scale = new THREE.Vector2(zs, zt);

  scale.set(xs, xt);
  let xp = new THREE.PlaneGeometry(width, height);
  for (let uvs of xp.faceVertexUvs[0]) {
    uvs[0].multiply(scale);
    uvs[1].multiply(scale);
    uvs[2].multiply(scale);
  }
  xp.rotateY(degToRad(90))
  xp.translate(-depth/2, height/2, 0);
  b.merge(xp, xp.matrix, 0);
  xp.translate(depth, 0, 0);
  b.merge(xp, xp.matrix, 0);

  scale.set(ys, yt);
  let yp = new THREE.PlaneGeometry(depth, width);
  for (let uvs of yp.faceVertexUvs[0]) {
    uvs[0].multiply(scale);
    uvs[1].multiply(scale);
    uvs[2].multiply(scale);
  }
  yp.rotateX(degToRad(90))
  // yp.rotateY(degToRad(-90))
  yp.translate(0, height, 0);
  b.merge(yp, yp.matrix, 1);
  yp.translate(0, -height, 0);
  b.merge(yp, yp.matrix, 1);

  scale.set(zs, zt);
  let zp = new THREE.PlaneGeometry(depth, height);
  for (let uvs of zp.faceVertexUvs[0]) {
    uvs[0].multiply(scale);
    uvs[1].multiply(scale);
    uvs[2].multiply(scale);
  }
  zp.translate(0, height/2, -width/2);
  b.merge(zp, zp.matrix, 2);
  zp.translate(0, 0, width);
  b.merge(zp, zp.matrix, 2);

  return b;
}

// function DoorFull() {

// }

function Quarter4() {
  let g = new THREE.Geometry();
  let p = Quarter1();
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  return g;
}
function Quarter1() {
  return new THREE.PlaneGeometry(1.0, TILE_Y).translate(0.0, TILE_Y * 0.5, -0.5);
}

function Full4() {
  let g = new THREE.Geometry();
  let p = Full1();
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  return g;
}
function Full1() {
  return new THREE.PlaneGeometry(1.0, TILE_Y * 4).translate(0.0, TILE_Y * 4 * 0.5, -0.5);
}

function Half4() {
  let g = new THREE.Geometry();
  let p = Half1();
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  return g;
}
function Half1() {
  return new THREE.PlaneGeometry(1.0, TILE_Y * 2).translate(0.0, TILE_Y * 2 * 0.5, -0.5);
}

function Tall4() {
  let g = new THREE.Geometry();
  let p = Tall1();
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  p.rotateY(degToRad(90));
  g.merge(p);
  return g;
}
function Tall1() {
  return new THREE.PlaneGeometry(1.0, TILE_Y * 8).translate(0.0, TILE_Y * 8 * 0.5, -0.5);
}

function FloorGeom() {
  return new THREE.PlaneGeometry(1, 1).rotateX(degToRad(-90)).translate(0.0, 0.0/*125*/, 0.0);
}

function mkFullWall1(name, ss = 1.0, st = 1.0) {
  return {
    geom: Full1(),
    scaleS: ss,
    scaleT: st,
    matn: name,
    blocks: [NORTH]
  }
}

function mkFullWall4(name, ss = 1.0, st = 1.0) {
  return {
    geom: Full4(),
    scaleS: ss,
    scaleT: st,
    matn: name,
    blocks: ALLDIRS
  }
}

function mkHalfWall1(name, ss = 1.0, st = 0.5) {
  return {
    geom: Half1(),
    scaleS: ss,
    scaleT: st,
    matn: name,
    blocks: [NORTH]
  }
}

function mkHalfWall4(name, ss = 1.0, st = 0.5) {
  return {
    geom: Half4(),
    scaleS: ss,
    scaleT: st,
    matn: name,
    blocks: ALLDIRS
  }
}

const ALLDIRS = [NORTH, EAST, SOUTH, WEST];
const TileModelDefs = {
  FloorHexes: {
    geom: FloorGeom(),
    matn: "FLOOR4_8",
    walkable: true
  },
  FloorHexesMoss: {
    geom: FloorGeom(),
    matn: "FLOOR5_1",
    walkable: true
  },
  FloorHexesTan1: {
    geom: FloorGeom(),
    matn: "FLOOR5_2",
    walkable: true
  },
  FloorHexesTan2: {
    geom: FloorGeom(),
    matn: "FLOOR5_3",
    walkable: true
  },
  FloorBlue: {
    geom: FloorGeom(),
    matn: "FLAT14",
    walkable: true
  },
  FloorRusyGrid: {
    geom: FloorGeom(),
    matn: "AQF049",
    walkable: true
  },
  FloorConcreteTiles: {
    geom: FloorGeom(),
    matn: "AQF051",
    walkable: true
  },
  FloorHexaRust: {
    geom: FloorGeom(),
    matn: "AQF074",
    walkable: true
  },
  FloorConcreteStripes: {
    geom: FloorGeom(),
    matn: "AQF068",
    walkable: true
  },
  FloorStripes: {
    geom: FloorGeom(),
    matn: "AQF019",
    walkable: true
  },
  FloorStripesBars: {
    geom: FloorGeom(),
    matn: "AQF018",
    walkable: true,
    exit: true
  },
  FloorCompVents: {
    geom: FloorGeom(),
    matn: "COMP04_8",
    walkable: true
  },
  FloorCompInnards: {
    geom: FloorGeom(),
    matn: "COMP04_1",
    walkable: true
  },

  BrownFullWall1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "WALL03_4",
    blocks: [SOUTH]
  },
  BrownFullWall4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "WALL03_4",
    blocks: ALLDIRS
  },

  BaseGrayFullWall1: mkFullWall1("SW11_1", 2.0, 0.5625),
  BaseGrayFullWall4: mkFullWall4("SW11_1", 2.0, 0.5625),
  BaseGray2FullWall1: mkFullWall1("SW15_3", 2.0, 0.5625),
  BaseGray2FullWall4: mkFullWall4("SW15_3", 2.0, 0.5625),

  BaseTanFullWall1: mkFullWall1("SW12_5", 2.0, 0.5625),
  BaseTanFullWall4: mkFullWall4("SW12_5", 2.0, 0.5625),
  BaseTan2FullWall1: mkFullWall1("SW17_4", 2.0, 0.5625),
  BaseTan2FullWall4: mkFullWall4("SW17_4", 2.0, 0.5625),
  BaseTan3FullWall1: mkFullWall1("SW17_5", 2.0, 0.5625),
  BaseTan3FullWall4: mkFullWall4("SW17_5", 2.0, 0.5625),

  BaseTanFullSide: {
    geom: Box(0.2, TILE_Y * 4, 1.0, {zs: 2.0, zt: 0.5625}).translate(0.0, 0.0, 0.5 - 0.1),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["SW12_5", "SW12_5", "SW12_5"],
    blocks: [SOUTH]
  },

  BaseTanHalfSide: {
    geom: Box(0.2, TILE_Y * 2, 1.0, {zs: 2.0, zt: 0.5625 * 0.5}).translate(0.0, 0.0, 0.5 - 0.1),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["SW12_5", "SW12_5", "SW12_5"],
    blocks: [SOUTH]
  },

  BaseTanQuarterSide: {
    geom: Box(0.2, TILE_Y * 1, 1.0, {zs: 2.0, zt: 0.5625 * 0.25}).translate(0.0, 0.0, 0.5 - 0.1),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["SW12_5", "SW12_5", "SW12_5"],
    blocks: []
  },

  baseGrayFullSide: {
    geom: Box(0.2, TILE_Y * 4, 1.0, {zs: 2.0, zt: 0.5625}).translate(0.0, 0.0, 0.5 - 0.1),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["SW11_1", "SW11_1", "SW11_1"],
    blocks: [SOUTH]
  },

  baseGrayHalfSide: {
    geom: Box(0.2, TILE_Y * 2, 1.0, {zs: 2.0, zt: 0.5625 * 0.5}).translate(0.0, 0.0, 0.5 - 0.1),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["SW11_1", "SW11_1", "SW11_1"],
    blocks: [SOUTH]
  },

  baseGrayQuarterSide: {
    geom: Box(0.2, TILE_Y * 1, 1.0, {zs: 2.0, zt: 0.5625 * 0.25}).translate(0.0, 0.0, 0.5 - 0.1),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["SW11_1", "SW11_1", "SW11_1"],
    blocks: []
  },

  GrnFullWall1: mkFullWall1("RW37_1", 1.0, 0.5625),
  GrnFullWall4: mkFullWall4("RW37_1", 1.0, 0.5625),
  Grn2FullWall1: mkFullWall1("RW37_2", 1.0, 0.5625),
  Grn2FullWall4: mkFullWall4("RW37_2", 1.0, 0.5625),

  Grn2HalfWall1: mkHalfWall1("RW37_2", 1.0, 0.25),
  Grn2HalfWall4: mkHalfWall4("RW37_2", 1.0, 0.25),

  RustyPanelsFullWall1: mkFullWall1("RW33_1", 1.0, 0.5),
  RustyPanelsFullWall4: mkFullWall4("RW33_1", 1.0, 0.5),
  RustyPanels2FullWall1: mkFullWall1("RW33_2", 1.0, 0.5),
  RustyPanels2FullWall4: mkFullWall4("RW33_2", 1.0, 0.5),

  TanFullWall1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "WALL02_1",
    blocks: [SOUTH]
  },
  TanFullWall4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "WALL02_1",
    blocks: ALLDIRS
  },

  Tan2FullWall1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "WALL02_2",
    blocks: [SOUTH]
  },
  Tan2FullWall4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "WALL02_2",
    blocks: ALLDIRS
  },

  TanHalfWall1: {
    geom: Half1(),
    scaleS: 1.0,
    scaleT: 0.5,
    matn: "WALL02_1",
    blocks: [SOUTH]
  },
  TanHalfWall4: {
    geom: Half4(),
    scaleS: 1.0,
    scaleT: 0.5,
    matn: "WALL02_1",
    blocks: ALLDIRS
  },

  Tan2HalfWall1: {
    geom: Half1(),
    scaleS: 1.0,
    scaleT: 0.5,
    matn: "WALL02_2",
    blocks: [SOUTH]
  },
  Tan2HalfWall4: {
    geom: Half4(),
    scaleS: 1.0,
    scaleT: 0.5,
    matn: "WALL02_2",
    blocks: ALLDIRS
  },

  FullDoor: {
    geom: Box(1.0, TILE_Y * 4, 0.4),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["DOOR3_6", "DOORTRAK", "DOORTRAK"],
    isDoor: true,
    blocks: []
  },
  FullRedDoor: {
    geom: Box(1.0, TILE_Y * 4, 0.4),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["DOOR3_6", "DOORTRAK", "DOORTRAK"],
    isDoor: true,
    needsRedKey: true,
    blocks: []
  },
  MetalFullDoor: {
    geom: Box(1.0, TILE_Y * 4, 0.4),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["DOOR3_5", "DOORTRAK", "DOORTRAK"],
    isDoor: true,
    blocks: []
  },

  TanTallDoor: {
    geom: Box(1.0, TILE_Y * 8, 0.5),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: ["DOOR15_4", "DOORTRAK", "DOORTRAK"],
    isDoor: true,
    blocks: []
  },
  // GrayFullDoor4: {
  //   geom: Box(),
  //   scaleS: 1.0,
  //   scaleT: 1.0,
  //   matn: "DOOR15_3",
  //   blocks: []
  // },

  CompsHalfSide: {
    geom: new THREE.BoxGeometry(1.0, TILE_Y * 2, 0.25).translate(0.0, TILE_Y * 2 * 0.5, 0.5),
    scaleS: 2.0,
    scaleT: 1.0,
    matn: "COMP02_3",
    blocks: [SOUTH]
  },

  Comps2HalfSide: {
    geom: Box(0.2, TILE_Y * 2, 1.0).translate(0.0, 0.0, 0.5 - 0.1),//new THREE.BoxGeometry(1.0, TILE_Y * 2, 0.2).translate(0.0, TILE_Y * 2 * 0.5, 0.5 - 0.1),
    scaleS: 2.0,
    scaleT: 1.0,
    matn: ["COMP03_4", "COMP03_4", "COMP02_3"],
    blocks: [SOUTH]
  },

  CompsFull1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP02_3",
    blocks: [SOUTH]
  },
  CompsFull4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP02_3",
    blocks: ALLDIRS
  },

  Comps2Full1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP02_5",
    blocks: [SOUTH]
  },
  Comps2Full4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP02_5",
    blocks: ALLDIRS
  },

  Comps3Full1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP02_1",
    blocks: [SOUTH]
  },
  Comps3Full4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP02_1",
    blocks: ALLDIRS
  },

  CompsPlainFull1: {
    geom: Full1(),
    scaleS: 2.0,
    scaleT: 1.0,
    matn: "COMP03_4",
    blocks: [SOUTH]
  },
  CompsPlainFull4: {
    geom: Full4(),
    scaleS: 2.0,
    scaleT: 1.0,
    matn: "COMP03_4",
    blocks: ALLDIRS
  },

  CompsVentsFull1: {
    geom: Full1(),
    scaleS: 2.0,
    scaleT: 1.0,
    matn: "COMP03_8",
    blocks: [SOUTH]
  },
  CompsVentsFull4: {
    geom: Full4(),
    scaleS: 2.0,
    scaleT: 1.0,
    matn: "COMP03_8",
    blocks: ALLDIRS
  },

  CompsInnardsFull1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP04_1",
    blocks: [SOUTH]
  },
  CompsInnardsFull4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP04_1",
    blocks: ALLDIRS
  },

  CompsBlueFull1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP03_2",
    blocks: [SOUTH]
  },
  CompsBlueFull4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "COMP03_2",
    blocks: ALLDIRS
  },

  RustyQuarter1: {
    geom: Quarter1(),
    scaleS: 1.0,
    scaleT: 0.25,
    matn: "RW10_2",
    blocks: [SOUTH]
  },
  RustyQuarter4: {
    geom: Quarter4(),
    scaleS: 1.0,
    scaleT: 0.25,
    matn: "RW10_2",
    blocks: ALLDIRS
  }
}

function initTileModelDefs() {
  let scale = new THREE.Vector2();
  for (let td in TileModelDefs) {
    let t = TileModelDefs[td];
    scale.set(t.scaleS || 1.0, t.scaleT || 1.0);
    for (let uvs of t.geom.faceVertexUvs[0]) {
      uvs[0].multiply(scale);
      uvs[1].multiply(scale);
      uvs[2].multiply(scale);
    }
    t.geom.uvsNeedUpdate = true;
    if (t.matn instanceof Array) {
      let mats = t.matn.map(texMat);
      t.mat = mats;
    }
    else t.mat = texMat(t.matn);
  }

  let tdp = document.querySelector("#TileDefPicker");
  if (tdp) {
    for (let td in TileModelDefs) {
      let el = document.createElement("div");
      el.className = "DefChoice";
      el.innerText = td;
      el.onclick = () => selectTileDef(td);
      tdp.appendChild(el);
    }
  } else {
    console.error("TDP not found?");
  }
}

function moveTowards(from, to, step) {
  let tmp = to.clone();
  tmp.sub(from);
  if (tmp.length() < step) {
    from.copy(to);
  } else {
    tmp.normalize();
    tmp.multiplyScalar(step);
    from.add(tmp);
  }
}

function callCombined(gens, dt) {
  let newgens = [];
  for (let g of gens) {
    let r = g.next(dt);
    if (!r.done) newgens.push(g);
  }
  return newgens;
}

function* doCombined(...gens) {
  while(gens.length != 0) {
    let dt = yield;
    gens = callCombined(gens, dt)
  }
}

function* doMoveTowards(from, to, unitsPerSecond) {
  while(!from.equals(to)) {
    let tmp = to.clone();
    let dt = yield;
    let step = unitsPerSecond * dt;
    tmp.sub(from);
    if (tmp.length() < step) {
      from.copy(to);
    } else {
      tmp.normalize();
      tmp.multiplyScalar(step);
      from.add(tmp);
    }
  }
}

function faceTowards(actor, position) {
  let cp = position.clone();
  cp.sub(actor.object.position)
  cp.y = 0;
  cp.normalize();
  let rads = new THREE.Vector2(cp.z, -cp.x).angle();;
  let degs = THREE.Math.radToDeg(rads);
  actor.facing = degs;
}

function* doFaceTowards(actor, position, degsPerSecond) {
  let cp = position.clone();
  cp.sub(actor.object.position)
  cp.y = 0;
  cp.normalize();
  let rads = new THREE.Vector2(cp.z, -cp.x).angle();;
  let degs = THREE.Math.radToDeg(rads);
  let needToRotate = degs - actor.facing;
  if (needToRotate > 180) needToRotate = needToRotate - 360;
  if (needToRotate < -180) needToRotate = needToRotate + 360;
  let stepSign = 1;
  if (needToRotate < 0) {
    stepSign = -1;
    needToRotate = -needToRotate;
  }
  let amountRotated = 0;
  while(actor.facing != degs) {
    let dt = yield;
    let step = degsPerSecond * dt;
    if (Math.abs(amountRotated - needToRotate) < step) {
      actor.facing = degs;
      amountRotated = needToRotate;
    } else {
      actor.facing += step * stepSign;
      amountRotated += step;
    }
  }
}

const DEFAULT_ROTATION_SPEED = 360;

function spawnProjectile(def, owner, at, dir) {
  let p = new DTActor(ActorDefs[def.projectile]);
  p.owner = owner;
  p.setPosition(at);
  p.setTravelDirection(dir);
  p.attackdef = def;
  g_World.addActor(p);
  faceTowards(p, p.position.clone().add(dir));
  p.update(0);
  return p;
}

function* doProcessProjectile(p) {
  let raycaster = new THREE.Raycaster();
  let oldPos = new THREE.Vector3();
  let intersected = [];
  while(p.isAlive()) {
    let dt = yield;

    if (!g_World.isWithinBounds(p.position)) {
      p.die();
      break;
    }

    oldPos.copy(p.position);
    let step = p.actordef.speed * dt
    let to = p.travelDirection.clone().multiplyScalar(step).add(p.position)
    let dist = step;
    raycaster.far = dist;
    raycaster.set(p.position, p.travelDirection.clone().normalize());
    moveTowards(p.position, to, step);

    intersected.length = 0;
    raycaster.intersectObjects(g_World.collidables, false, intersected);
    if (intersected.length) {
      let hitSomething = false;
      for (const data of intersected) {
        const int = data.object;
        if (int === p.collisionObject || int === p.owner.collisionObject || (int.dtacActor && !int.dtacActor.isAlive())) continue;
        hitSomething = true;
        const a = int.dtacActor;
        if (a && !a.isProjectile && a != p.owner) {
          a.hurt(p.attackdef.damage.roll(), p);
        }
      }
      if (hitSomething) p.die();
    }
  }
}

function* startAnimAndWaitForEvent(anim, eventName) {
  anim.start();
  let done = false;
  let success = false;
  anim.events.on(eventName, () => success = done = true, true);
  anim.events.on("finished", () => done = true, true);
  while(!done) yield;
  return success;
}

const getPosAndDirForAttack = (function(){
  let mx = new THREE.Matrix4();
  let eye = new THREE.Vector3(0,0,0);
  let up = new THREE.Vector3(0,1,0);
  return function(actor, victim, attackDef, pos, dir) {
    let ret = !(pos && dir);
    pos = pos ? pos.copy(actor.position) : actor.position.clone();
    pos.y += 0.75;
    dir = (dir ? dir.copy(victim.position) : victim.position.clone()).sub(pos);
    dir.y += 0.75;
    dir.normalize();

    mx.lookAt(dir, eye, up);
    dir.set(0, 0, 1);
    if (attackDef) {
      let {horizontalSpread: hs, verticalSpread: vs} = attackDef;
      dir.applyEuler(new THREE.Euler(
        THREE.Math.degToRad(randomBetween(-vs, vs+1)),
        THREE.Math.degToRad(randomBetween(-hs, hs+1)),
        0));
    }
    dir.applyMatrix4(mx);

    pos.add(dir.clone().multiplyScalar(0.01));

    if (ret) return [pos, dir];
  }
})();

function* doWait(time) {
  while(time > 0) time -= yield;
}

function* doAttack(actor, victim, attackDef, specialWeapon) {
  if (actor === victim) {
    console.error("An actor can't attack itself");
    return;
  }
  yield* doFaceTowards(actor, victim.position, DEFAULT_ROTATION_SPEED);
  if (attackDef.isMelee) {
    actor.playAnim("attackAnim", false);
    yield* startAnimAndWaitForEvent(actor.anim, "attack");
    victim.hurt(attackDef.damage.roll(), actor);
    yield* doWait(0.3);
    return;
  }

  let projectiles = [];
  let trackProjectile = (attackDef.shots == 1 && attackDef.bulletsPerShot == 1)
  if (!trackProjectile) g_TrackedActor = victim;
  let waitingForFinish = false;
  for (let shot = 0; shot < attackDef.shots; shot++) {
    while (waitingForFinish) {
      let dt = yield;
      projectiles = callCombined(projectiles, dt);
    }
    if (attackDef.shots != 1 && actor.hasAnim("attackAnimBurst")) actor.playAnim("attackAnimBurst", false);
    else actor.playAnim("attackAnim", false);
    let waiting = true;
    waitingForFinish = true;
    actor.anim.events.on("attack", () => waiting = false, true);
    actor.anim.events.on("finished", () => waitingForFinish = false, true);
    actor.anim.start();
    while (waiting) {
      let dt = yield;
      projectiles = callCombined(projectiles, dt);
    }

    if (specialWeapon) specialWeapon.shots -= 1;

    if (attackDef.attackSound) attackDef.attackSound.play();
    for (let bullet = 0; bullet < attackDef.bulletsPerShot; bullet++) {
      let [pos, dir] = getPosAndDirForAttack(actor, victim, attackDef);

      let p = spawnProjectile(attackDef, actor, pos, dir);
      if (trackProjectile) g_TrackedActor = p;
      projectiles.push(doProcessProjectile(p));
    }
  }
  yield* doCombined(...projectiles);
  yield* doWait(0.8);
}

function* doTravel(actor, path) {
  actor.playAnim("walkAnim");
  for (let tile of path) {
    if (tile === actor.tile) continue;
    let tpos = tile.position.clone();
    if (tile.hasDoor && !tile.isDoorOpen) {
      yield* tile.doOpenDoor();
    }
    // tpos.y += 0.5;
    yield* doCombined(
      doFaceTowards(actor, tpos, DEFAULT_ROTATION_SPEED),
      doMoveTowards(actor.object.position, tpos, 4)
    );
    actor.setTile(tile);
  }
  actor.playAnim("idleAnim");
}

const walkableObjectMaterialTest = new THREE.MeshLambertMaterial({color: 0x00ffff, transparent: true, opacity: 0.25})
const walkableObjectMaterial = new THREE.MeshLambertMaterial({color: 0xffff00, transparent: true, opacity: 0.25})
const walkableObjectMaterialInvisible = new THREE.MeshLambertMaterial({color: 0x00ffff, visible: false})
class DTTile {
  constructor(tiledef, x, y, z) {
    let {parts, things} = this.tiledef = tiledef;
    this.object = new THREE.Group();
    this.links = [];
    this.blocked = [];
    this.setPosition(x, y, z);

    if (tiledef.actor && tiledef.actor.def) {
      this.actordefActor = new DTActor(ActorDefs[tiledef.actor.def]);
      this.actordefActor.discover(false);
      this.actordefActor.setPosition(this.position);
    }

    this.doorObjects = [];
    this.renderObjects = [];
    this.walkableObjects = [];
    for (let part of parts) {
      let tmd = TileModelDefs[part.def];
      let rot = "rotationY" in part ? part.rotationY : ROT0;
      let r = ROTtoRads(rot);
      let tr = (rot / MAX_ROT) * 0.01;
      for (let blockDir of tmd.blocks || []) {
        let d = rotDir(rot, blockDir);
        if (this.blocked.indexOf(d) == -1) this.blocked.push(d);
      }

      if (tmd.exit) {
        this.isExit = true;
      }

      let renderObject = new THREE.Mesh(tmd.geom, tmd.mat);
      renderObject.scale.z = 1.0 + tr;
      renderObject.scale.y = 1.0 + tr / 4;
      // renderObject.scale.x = 1.0;
      renderObject.rotateY(r);
      renderObject.dtacTile = this;
      renderObject.dtacDef = tmd;
      if (tmd.isDoor) {
        this.hasDoor = true;
        this.isDoorOpen = false;
        if (!this.doorObject) {
          this.doorObject = new THREE.Group();
          this.object.add(this.doorObject);
        }
        this.doorObject.add(renderObject);
        this.doorObjects.push(renderObject);
      } else {
        this.renderObjects.push(renderObject);
      }

      if (tmd.walkable) {
        let walkableObject = new THREE.Mesh(tmd.geom, walkableObjectMaterialInvisible);
        walkableObject.rotateY(r);
        walkableObject.position.y += 0.01;
        walkableObject.dtacTile = this;
        this.walkableObjects.push(walkableObject);
      }
    }

    if (!OPTIMIZE_WORLD) for (let ro of this.renderObjects) this.object.add(ro);
    this.object.dtacTile = this;
    for (let wo of this.walkableObjects) this.object.add(wo);

    this.id = XYZtoID(x, y, z);
  }

  *doOpenDoor() {
    if (this.isDoorOpen) return;
    this.isDoorOpen = true;
    let to = this.doorObject.position.clone();
    to.y -= (TILE_Y * 4) * 0.925;
    yield* doMoveTowards(this.doorObject.position, to, 1.6);
  }

  *doCloseDoor() {
    if (!this.isDoorOpen) return;
    this.isDoorOpen = false;
    let to = this.doorObject.position.clone();
    to.y += (TILE_Y * 4) * 0.925;
    yield* doMoveTowards(this.doorObject.position, to, 1.9);
  }

  setPosition(x, y, z) {
    this.object.position.set(x * TILE_X, y * TILE_Y, z * TILE_Z);
    // this.tposition.set(x, y, z);
  }
  get position() { return this.object.position; }

  blocks(dir) { return this.blocked.indexOf(dir) !== -1; }

  addTwoWayLink(other) {
    if (this.links.indexOf(other) == -1) this.links.push(other);
    if (other.links.indexOf(this) == -1) other.links.push(this);
  }

  get walkable() { return this.walkableObjects.length != 0; }

  removeAllLinks() {
    for (let other of this.links) {
      swapRemove(other.links, this);
    }

    this.links.length = 0;
  }

  distanceTo(other) {
    return this.position.distanceTo(other.position);
  }

  isOccupied() {
    return !!this.actor;
  }

  get actor() {
    return this._actor;
  }

  set actor(actor) {
    this._actor = actor;
  }
}

function XYZtoID(x, y, z) {
  return (0xFF & x) | (0xFF & y) << 8 | (0xFF & z) << 16;
}

function IDtoXYZ(id, into=[0, 0, 0]) {
  into[0] = (0xFF & id);
  into[1] = 0xFF & id >> 8;
  into[2] =  0xFF & id >> 16;
  return into;
}

function findReachableTiles(from, range) {
  if (range === undefined) throw "Undefined range";
  let reachables = [];
  let alreadyChecked = new Set();
  let toCheck = [[from, 0]];
  alreadyChecked.add(from);

  while(toCheck.length) {
    let [t, l] = toCheck.shift();
    alreadyChecked.add(t);
    let r = l + 1;
    if (r > range) continue;

    for (let n of t.links) {
      if (!n.isOccupied() && !alreadyChecked.has(n) && !toCheck.find(([t, l]) => t === n)) {
        toCheck.push([n, r]);
        reachables.push({tile: n, from: t});
      }
    }
  }

  return reachables;
}

function _reconstructPath(cameFrom, current) {
  let path = [current];
  while (current = cameFrom[current.id]) {
    path.push(current);
  }
  path.reverse();
  return path;
}

function findPath(from, to) {
  let cameFrom = {};

  let gscore = {};
  gscore[from.id] = 0;
  const getG = (n) => (n.id in gscore) ? gscore[n.id] : Number.POSITIVE_INFINITY;
  let fscore = {};
  fscore[from.id] = from.distanceTo(to)
  const getF = (n) => (n.id in fscore) ? fscore[n.id] : Number.POSITIVE_INFINITY;

  let closedSet = new Set();
  let openSet = new Set();
  openSet.add(from);
  let queue = new PriorityQueue({comparator: (a, b) => getF(a) - getF(b)});
  queue.queue(from);

  let closestDist;
  let closest;
  while (queue.length) {
    let current = queue.dequeue();

    if (current === to) return {path: _reconstructPath(cameFrom, current), found: true};

    {
      let cd;
      if (!closest) {
        closest = current;
        closestDist = closest.distanceTo(to);
      } else if ((cd = current.distanceTo(to)) < closestDist) {
        closest = current;
        closestDist = cd;
      }
    }

    closedSet.add(current);

    for (let link of current.links) {
      if (link.isOccupied()) continue;
      if (closedSet.has(link)) continue;

      let g = getG(current) + current.distanceTo(link);

      if (!openSet.has(link)) {
        openSet.add(link);
      } else if (g >= getG(link)) {
        continue;
      }

      cameFrom[link.id] = current;
      gscore[link.id] = g;
      fscore[link.id] = g + link.distanceTo(to);
      queue.queue(link);
    }
  }

  //return [];
  if (closest) {
    return {path: _reconstructPath(cameFrom, closest), found: false};
  } else {
    return {path: [], found: false};
  }
}

function makePlainMapDef(width, height) {
  let tiles = {};
  let mapdef = {width, height, tiles};

  for (let x = 0; x < width; x++) {
    for (let z = 0; z < height; z++) {
      let t = {
        x: x,
        y: 0,
        z: z,
        parts: [
          {def: "FloorHexes", rotationY: 0},
        ],
        things: []
      }
      tiles[XYZtoID(x, 0, z)] = t;
    }
  }

  return mapdef;
}

class DTWorld {
  constructor(mapdef = Maps.Map1 || loadMapdef() || makePlainMapDef(16, 16)) {
    this.grid = [];
    this.tiles = [];
    this.walkable = [];
    this.pickable = [];
    this.collidables = [];
    this.actors = [];
    this.actordefPreviews = [];
    let scene = this.scene = new THREE.Scene();
    this.mapdef = mapdef;
    this.bbox = new THREE.Box3();
    // this.bbox.expandByPoint(new THREE.Vector3(0, 20, 0));
    this.side = SIDE_AI;
    scene.add(g_ActorHoverCursor); // oops

    this.initMap();

    let ambientLight = new THREE.AmbientLight( 0xffffff, 0.5 );
    scene.add(ambientLight)
    let sun = new THREE.DirectionalLight( 0xffffff, 0.2 );
    sun.position.set(0, 0, 0);
    sun.castShadow = true;
    scene.add(sun);
    scene.add(sun.target);
    sun.target.position.set(-1, -1.5, -2.34);

    // let mydef = ActorDefs.Imp;//.resourcesFound ? ActorDefs.Imp : ActorDefs.Serpentipede;
    // let mydef2 = ActorDefs.HellKnight;//.resourcesFound ? ActorDefs.HellKnight : ActorDefs.PainBringer;
    // {
    //   let actor;
    //   actor = new DTActor(mydef);
    //   actor.side = SIDE_PLAYER;
    //   actor.setTile(this.tileAt(3, 0, 3));
    //   this.addActor(actor);

    //   actor = new DTActor(mydef);
    //   actor.side = SIDE_PLAYER;
    //   actor.setTile(this.tileAt(4, 0, 7));
    //   this.addActor(actor);

    //   actor = new DTActor(ActorDefs.FreedoomGuy);
    //   actor.side = SIDE_PLAYER;
    //   actor.setTile(this.tileAt(8, 0, 2));
    //   this.addActor(actor);

    //   actor = new DTActor(ActorDefs.DoomGuy);//.resourcesFound ? ActorDefs.DoomGuy : ActorDefs.FreedoomGuy);
    //   actor.side = SIDE_PLAYER;
    //   actor.setTile(this.tileAt(10, 0, 2));
    //   this.addActor(actor);
    // }

    // {
    //   let actor2;
    //   actor2 = new DTActor(ActorDefs.Baron);
    //   actor2.setTile(this.tileAt(8, 0, 4));
    //   actor2.side = SIDE_AI;
    //   this.addActor(actor2);
    // }

    if (OPTIMIZE_WORLD) {
      this.optimize();
    }
  }

  optimize() {
    let objects = [];
    let byDef = new Map();
    for (let tile of this.tiles) {
      for (let ro of tile.renderObjects) {
        let values;
        if (!byDef.has(ro.dtacDef)) byDef.set(ro.dtacDef, values = [])
        else values = byDef.get(ro.dtacDef);
        values.push(ro);
      }
    }

    let mat4 = new THREE.Matrix4();
    for (let group of byDef.values()) {
      let geom = new THREE.Geometry();
      let mat;
      for (let ro of group) {
        ro.dtacTile.object.add(ro);
        ro.updateMatrixWorld();
        mat4.copy(ro.matrixWorld);
        ro.dtacTile.object.remove(ro);
        geom.merge(ro.geometry, mat4);
        mat = ro.material;
      }
      objects.push(new THREE.Mesh(geom, mat));
    }

    console.log(objects.length);
    for (let object of objects) {
      this.scene.add(object);
    }
  }

  initMap() {
    let v = [0, 0, 0];
    for (let id in this.mapdef.tiles) {
      let [x, y, z] = IDtoXYZ(id, v);
      let tiledef = this.mapdef.tiles[id];
      this.setTileFromDef(x, y, z, tiledef);
      if (tiledef.actor) {
        let actor = new DTActor(ActorDefs[tiledef.actor.def]);
        actor.setTile(this.tileAt(x, y, z));
        this.addActor(actor);
      }
    }

    for (let id in this.mapdef.tiles) {
      let [x, y, z] = IDtoXYZ(id, v);
      this.createTileLinks(x, y, z);
    }
  }

  _getLink(x, y, z, yd, dir) {
    let g = this.grid;
    let t = g[XYZtoID(x, y, z)];
    let xd = 0, zd = 0;
    switch(dir) {
      case EAST: xd = +1; break;
      case WEST: xd = -1; break;
      case NORTH: zd = -1; break;
      case SOUTH: zd = +1; break;
      default: throw "Invalid dir " + dir;
    }
    let o = g[XYZtoID(x + xd, y + yd, z + zd)];
    return (o && o.walkable && !t.blocks(dir) && !o.blocks(oppositeDir(dir))) ? o : null;
  }

  createTileLinks(x, y, z) {
    let t = this.grid[XYZtoID(x, y, z)], o;
    if (!t.walkable) return;

    for (let yd = -1; yd <= 1; yd++)
    {
      let n, e, s, w;
      n = e = s = w = false;
      if (o = this._getLink(x, y, z, yd, EAST)) { e = true; t.addTwoWayLink(o); }
      if (o = this._getLink(x, y, z, yd, WEST)) { w = true; t.addTwoWayLink(o); }
      if (o = this._getLink(x, y, z, yd, NORTH)) { n = true; t.addTwoWayLink(o); }
      if (o = this._getLink(x, y, z, yd, SOUTH)) { s = true; t.addTwoWayLink(o); }

      if (yd == 0) {
        if (n && e && this._getLink(x + 1, y, z, 0, NORTH) && (o = this._getLink(x, y, z - 1, 0, EAST))) t.addTwoWayLink(o);
        if (n && w && this._getLink(x - 1, y, z, 0, NORTH) && (o = this._getLink(x, y, z - 1, 0, WEST))) t.addTwoWayLink(o);
        if (s && w && this._getLink(x - 1, y, z, 0, SOUTH) && (o = this._getLink(x, y, z + 1, 0, WEST))) t.addTwoWayLink(o);
        if (s && e && this._getLink(x + 1, y, z, 0, SOUTH) && (o = this._getLink(x, y, z + 1, 0, EAST))) t.addTwoWayLink(o);
      }
    }
  }

  setTileFromDef(x, y, z, tiledef) {
    // FIXME refresh links here
    let old = this.grid[XYZtoID(x, y, z)];
    if (old) {
      old.removeAllLinks();
      swapRemove(this.tiles, old);
      for (let ro of old.renderObjects) swapRemove(this.collidables, ro);
      for (let ro of old.doorObjects) swapRemove(this.collidables, ro);
      for (let wo of old.walkableObjects) {
        swapRemove(this.walkable, wo);
        swapRemove(this.pickable, wo);
      }
      this.scene.remove(old.object);
      if (old.actordefActor) {
        this.scene.remove(old.actordefActor.object);
        swapRemove(this.actordefPreviews, old.actordefActor);
      }
    }

    let t = new DTTile(tiledef, x, y, z);
    this.tiles.push(t);
    for (let ro of t.renderObjects) this.collidables.push(ro);
    for (let ro of t.doorObjects) this.collidables.push(ro);
    for (let wo of t.walkableObjects) {
      this.walkable.push(wo);
      this.pickable.push(wo);
    }
    this.scene.add(t.object);
    if (t.actordefActor) {
      this.scene.add(t.actordefActor.object);
      this.actordefPreviews.push(t.actordefActor);
      t.actordefActor.object.visible = g_Mode == EDIT_MODE;
    }
    this.grid[XYZtoID(x, y, z)] = t;
    this.bbox.expandByObject(t.object);

    if (old && old.actor) {
      old.actor.setTile(t);
    }
  }

  isWithinBounds(position) {
    return this.bbox.containsPoint(position);
  }

  addActor(actor) {
    this.scene.add(actor.object);
    this.actors.push(actor);
    if (actor.collisionObject) {
      this.collidables.push(actor.collisionObject);
      this.pickable.push(actor.collisionObject);
    }

    if (actor.infoElement) document.body.append(actor.infoElement);
    this.pickable.push(actor.renderObject);
  }

  removeActor(actor) {
    this.scene.remove(actor.object);
    // this.actors.delete(actor);
    swapRemove(this.actors, actor);
    if (actor.collisionObject) {
      swapRemove(this.collidables, actor.collisionObject);
      swapRemove(this.pickable, actor.collisionObject)
    }

    if (actor.infoElement) actor.infoElement.remove();
    swapRemove(this.pickable, actor.renderObject);
  }

  tileAt(x, y, z) {
    if (y === undefined) var {x, y, z} = x;
    return this.grid[XYZtoID(x, y, z)];
  }
}

const ACTOR_EYES = 0.75;
const ACTOR_OFFSET = 0.0;
const ActorCollisionGeom = new THREE.CylinderGeometry(0.35, 0.35, 1, 8, 1);
{ ActorCollisionGeom.translate(0, 0.5, 0); }
const ActorCollisionMaterial = new THREE.MeshBasicMaterial({color: 0xff00ff, wireframe: true, visible: false});
class DTActor {
  constructor(actordef) {
    this._dead = false;
    while(!actordef.resourcesFound) {
      if (actordef.replaceWith) {
        actordef = ActorDefs[actordef.replaceWith];
      } else {
        throw "No suitable actordef in loaded WADs";
      }
    }
    this.actordef = actordef;
    this.painLastPlayed = 0;

    this.hp = this.maxHp;
    if ("sideOverride" in actordef) this.side = actordef.sideOverride;
    else this.side = SIDE_AI;
    this.discovered = actordef.isProjectile || actordef.isItem || this.side == SIDE_PLAYER;

    let geometry = new THREE.PlaneGeometry( 1, 1, 1 );
    geometry.translate(0, 0.5, 0);

    let matparams = {color: 0xffffff, side: THREE.DoubleSide, transparent: true};
    let material = new (actordef.fullbright ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial)(matparams);
    material.alphaTest = 0.1;
    material.map = null;

    if (!actordef.isProjectile) {
      let behindMat = new THREE.MeshBasicMaterial({
        color: this.actordef.isItem ? 0xffff00 : (this.side == SIDE_PLAYER ? 0x00ff00 : 0xff0000),
        transparent: true
      });
      behindMat.depthFunc = THREE.GreaterDepth;
      behindMat.opacity = 0.25;
      behindMat.alphaTest = 0.1;
      behindMat.depthWrite = false;
      behindMat.map = null;
      this.renderObjectBehind = new THREE.Mesh(geometry, behindMat);
      this.renderObjectBehind.dtacActor = this;
      this.renderObjectBehind.visible = false;
    }

    this.renderObject = new THREE.Mesh( geometry, material );
    this.renderObject.dtacActor = this;
    this.renderObject.castShadow = true;
    this.renderObject.visible = false;

    if (!actordef.isProjectile && !actordef.isItem) {
      this.collisionObject = new THREE.Mesh(ActorCollisionGeom, ActorCollisionMaterial);
      this.collisionObject.dtacActor = this;

      let info = document.createElement("div");
      let cth = document.createElement("div");
      let hp = document.createElement("div");
      info.className = "ActorHoverInfo";
      hp.className = "HPLabel";
      info.append(cth);
      info.append(hp);
      info.style.display = "none";

      this.infoElement = info;
      this.infoElementHp = hp;
    }

    this.facing = 0;
    let facingDir = new THREE.Vector3( 0, 0, 1 );
    let facingArrow = new THREE.ArrowHelper(facingDir, new THREE.Vector3(0, 0, 0), 0.5);
    facingArrow.visible = false;

    this.object = new THREE.Group();
    this.object.dtacActor = this;
    this.object.add(this.renderObject);
    if (this.renderObjectBehind) this.object.add(this.renderObjectBehind);
    if (this.collisionObject) this.object.add(this.collisionObject);
    this.object.add(facingArrow);
    this.object.translateY(ACTOR_OFFSET);

    this.playAnim("idleAnim");

    // let uniforms = { texture:  { type: "t", value: 0, texture: null } };
    // let vertexShader = document.getElementById( 'vertexShaderDepth' ).textContent;
    // let fragmentShader = document.getElementById( 'fragmentShaderDepth' ).textContent;
    // this.renderObject.customDepthMaterial = new THREE.ShaderMaterial( { uniforms: uniforms, vertexShader: vertexShader, fragmentShader: fragmentShader } );

    this.renderObject.onBeforeRender = (r, s, cam) => {
      let v = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.Math.degToRad(-this.facing));
      facingArrow.setDirection(v);
    }

    this.resetActions();

    if (this.discovered) this.discover();
  }

  get isItem() {
    return this.actordef && this.actordef.isItem;
  }

  getWeapon() {
    let sp = this.specialWeapon;
    if (sp && sp.shots > 0) return sp.def;
    return this.actordef.weapons[0];
  }

  pickupSpecialWeapon(def, shots=def.shots * 9) {
    if (this.specialWeapon && this.specialWeapon.def == def) {
      this.specialWeapon = {
        shots: shots + this.specialWeapon.shots,
        def: def
      };
    } else {
      this.specialWeapon = {
        shots: shots,
        def: def
      };
    }
  }

  get maxHp() {
    return this.actordef.hp || 1;
  }

  discover(playSound=true) {
    if (playSound && !this.discovered && this.actordef.sightSounds) choose(this.actordef.sightSounds).play();
    this.discovered = true;
    this.renderObject.visible = true;
    if (this.renderObjectBehind) this.renderObjectBehind.visible = true;
    if (this.infoElement) this.infoElement.style.display = "block";
  }

  get maxActions() { return 2; }

  resetActions() {
    this.actionsLeft = this.maxActions;
  }

  get travelRange() {
    return this.actordef.travelRange || 0;
  }

  canAct() {
    return this.actionsLeft > 0 && !this.actordef.isItem && (this.side == SIDE_PLAYER || this.discovered);
  }

  takeAction() {
    if (!this.canAct()) throw "Can't take anymore actions";
    this.actionsLeft -= 1;
  }

  takeAllActions() {
    this.actionsLeft = 0;
  }

  update(dt) {
    if (this.anim.isFinished()) {
      if (this.anim.name == "walkAnim") {
        this.playAnim("walkAnim");
      } else {
        this.playAnim("idleAnim");
      }
    }
    this.anim.advance(dt);

    if (!this.isAlive()) {
      let playingDeath = this.anim && !this.anim.isFinished() && (this.anim.name == "deathAnim" || this.anim.name == "deathAnimX");
      if (!playingDeath) {
        g_World.removeActor(this);
      } else if (this.anim.ticsToGo == -1) {
        if (this.renderObjectBehind) this.object.remove(this.renderObjectBehind);
      }
    }

    if (this.infoElement) {
      moveElementTo(this.infoElement, this.object.position);
      this.infoElementHp.innerText = `HP: ${this.hp}/${this.maxHp}`;
    }

    let cam = g_MainCamera;
    let cp = cam.position.clone();
    cp.y *= 0.2;
    this.renderObject.lookAt(cp);
    if (this.renderObjectBehind) this.renderObjectBehind.lookAt(cp);

    cp.sub(this.object.position)
    cp.y = 0;
    cp.normalize();
    let rads = new THREE.Vector2(cp.z, cp.x).angle();
    let degs = THREE.Math.radToDeg(rads);
    degs += 22.5 + this.facing;
    let dir = (((degs / 45)|0) % 8);

    let fr = this.anim.frame.bydir[dir];
    if (!fr) fr = this.anim.frame.bydir[0];
    for (let ro of [this.renderObject, this.renderObjectBehind]) {
      if (!ro) continue;
      if (ro.material.map != fr.texture) {
        ro.material.map = fr.texture;
        ro.material.needsUpdate = true;

        // let utx = ro.customDepthMaterial.uniforms.texture;
        // utx.value = fr.texture;
        // ro.customDepthMaterial.needsUpdate = true;

        const div = 64;
        let xx = fr.graphic.width / div;
        let xo = fr.graphic.xOffset / div;
        let yy = fr.graphic.height * 1.2 / div;
        let yo = (fr.graphic.yOffset + 5) * 1.2 / div;
        ro.position.y = yo - yy;
        ro.position.x = xo - xx/2;
        ro.scale.set(xx, yy, 1)
      }
    }
  }

  setAnim(anim, start = true) {
    this.anim = anim;
    if (start && this.anim) this.anim.start();
  }

  hasAnim(animName) {
    return this.actordef.parsedAnims[animName] !== undefined;
  }

  playAnim(animName, start = true) {
    if (this.anim && this.anim.name == animName) {
      this.anim.start();
      return;
    }

    let pa = this.actordef.parsedAnims[animName];
    if (!pa) throw "No anim " + animName + " for actor " + this.actordef.name;
    let anim = new DTDoomSpriteAnim(animName, pa);
    this.setAnim(anim, start);
  }

  setTile(tile, warpTo = true) {
    if (this.actordef.isItem) {
      if (tile && tile.item) throw "Some item already is on that tile";
      if (this.tile) this.tile.item = null;
      this.tile = tile;
      if (this.tile) this.tile.item = this;
    } else {
      if (tile && tile.actor) throw "Something already stands on that tile";
      if (this.tile) this.tile.actor = null;
      this.tile = tile;
      if (this.tile) this.tile.actor = this;

      if (this.side == SIDE_PLAYER && this.tile && this.tile.item) {
        if (this.tile.item.actordef.onpickup(this)) {
          this.tile.item.die();
        }
      }
    }

    if (this.tile && warpTo) {
      const {x, y, z} = tile.position;
      this.setPosition(x, y, z);
    }

    if (!this.actordef.isItem) this.visibilityCheck();
  }

  visibilityCheck(forDiscovered=0) {
    if (forDiscovered > 1) return;
    if ((forDiscovered || this.side == SIDE_PLAYER) && g_World) {
      let pos = new THREE.Vector3(), dir = new THREE.Vector3();
      let intersected = [];
      for (let actor of g_World.actors) {
        if (actor !== this && actor.side != SIDE_PLAYER && !actor.discovered) {
          // actor.object.updateMatrixWorld();
          // actor.collisionObject.updateMatrixWorld();
          // console.log(actor.collisionObject.visible);
          getPosAndDirForAttack(this, actor, null, pos, dir);
          g_Raycaster.set(pos, dir);
          intersected.length = 0;
          g_Raycaster.intersectObjects(g_World.collidables, false, intersected);
          for (let {object: {dtacActor}} of intersected) {
            if (!dtacActor) break;
            if (dtacActor == actor) {
              actor.discover();
              actor.visibilityCheck(forDiscovered + 1);
              break;
            }
          }
        }
      }
    }
  }

  setPosition(x, y, z) {
    if (y === undefined) this.object.position.copy(x);
    else this.object.position.set(x, y, z);
    this.object.updateMatrixWorld();
  }

  get position() {
    return this.object.position;
  }

  set position(value) {
    this.object.position = value;
  }

  get isProjectile() {
    return !!this.actordef.isProjectile;
  }

  setTravelDirection(dir) {
    if (!this.travelDirection) this.travelDirection = new THREE.Vector3();
    this.travelDirection.copy(dir);
  }

  heal(amount, overheal=false) {
    if (!this.isAlive()) return;

    let pos = this.position.clone();
    pos.y += 1.1;
    makeDamagePopup(this, pos, amount);
    if (overheal) this.hp += amount;
    else this.hp = Math.min(this.hp + amount, this.actordef.hp);
  }

  hurt(damage, source) {
    let pos = this.position.clone();
    pos.y += 1.1;
    makeDamagePopup(this, pos, -damage);
    this.hp -= damage;
    if (this.hp <= 0) this.die(this.hp < -3);
    else {
      let now = performance.now();
      if ((now - this.painLastPlayed) > 500 && this.actordef.painSounds) {
        this.painLastPlayed = now;
        choose(this.actordef.painSounds).play();
      }
      if (this.hasAnim("painAnim")) {
        this.playAnim("painAnim");
      }
    }
  }

  isAlive() {
    return this._dead !== true;
  }

  die(gib = false) {
    if (this.actordef.deathSounds) choose(this.actordef.deathSounds).play();
    if (this.infoElement) this.infoElement.remove();
    this._dead = true;
    this.setTile(null);
    if (gib && this.hasAnim("deathAnimX")) {
      this.playAnim("deathAnimX");
    } else if (this.hasAnim("deathAnim")) {
      this.playAnim("deathAnim");
    } else {
      g_World.removeActor(this);
    }
  }
}

const LightUp = {}

const ImpSerpRaws = {
  idleAnim: [
    ["TROO", "AB", 15]
  ],
  walkAnim: [
    ["TROO", "ABCD", 4, "travel"]
  ],
  attackAnim: [
    ["TROO", "EF", 8],
    ["TROO", "G", 6, "attack"]
  ],
  painAnim: [
    ["TROO", "H", 8, "pain"]
  ],
  deathAnim: [
    ["TROO", "I", 8],
    ["TROO", "J", 8, "deathscream"],
    ["TROO", "K", 6],
    ["TROO", "L", 6, "noblocking"],
    ["TROO", "M", -1],
  ],
  deathAnimX: [
    ["TROO", "N", 5],
    ["TROO", "O", 5, "xdeathscream"],
    ["TROO", "P", 5],
    ["TROO", "Q", 5, "noblocking"],
    ["TROO", "RST", 5],
    ["TROO", "U ", -1],
  ],
};

const ImpSerpBallRaws = {
  idleAnim: [
    ["BAL1", "AB", 4]
  ],
  deathAnim: [
    ["BAL1", "CDE", 6]
  ]
}

const BaronPLRaws = {
  idleAnim: [
    ["BOSS", "AB", 12]
  ],
  walkAnim: [
    ["BOSS", "ABCD", 4, "travel"]
  ],
  attackAnim: [
    ["BOSS", "EF", 8],
    ["BOSS", "G", 6, "attack"]
  ],
  painAnim: [
    ["BOSS", "H", 8, "pain"]
  ],
  deathAnim: [
    ["BOSS", "I", 8],
    ["BOSS", "J", 8, "deathscream"],
    ["BOSS", "K", 6],
    ["BOSS", "L", 6, "noblocking"],
    ["BOSS", "MN", 8],
    ["BOSS", "O", -1],
  ]
}

const HKPBRaws = {
  idleAnim: [
    ["BOS2", "AB", 12]
  ],
  walkAnim: [
    ["BOS2", "ABCD", 4, "travel"]
  ],
  attackAnim: [
    ["BOS2", "EF", 8],
    ["BOS2", "G", 6, "attack"]
  ],
  painAnim: [
    ["BOS2", "H", 8, "pain"]
  ],
  deathAnim: [
    ["BOS2", "I", 8],
    ["BOS2", "J", 8, "deathscream"],
    ["BOS2", "K", 6],
    ["BOS2", "L", 6, "noblocking"],
    ["BOS2", "MN", 8],
    ["BOS2", "O", -1],
  ]
}

const HKPBBallRaws = {
  idleAnim: [
    ["BAL7", "AB", 4]
  ],
  deathAnim: [
    ["BAL7", "CDE", 6]
  ]
}

const PlayerRaws = {
  idleAnim: [
    ["PLAY", "AB", 12]
  ],
  walkAnim: [
    ["PLAY", "ABCD", 4, "travel"]
  ],
  attackAnim: [
    ["PLAY", "E", 8],
    ["PLAY", "F", 8, "attack"],
    ["PLAY", "E", 8],
  ],
  attackAnimBurst: [
    ["PLAY", "E", 4],
    ["PLAY", "F", 4, "attack"],
  ],
  painAnim: [
    ["PLAY", "G", 8, "pain"]
  ],
  deathAnim: [
    ["PLAY", "H", 10],
    ["PLAY", "I", 10, "deathscream"],
    ["PLAY", "J", 10, "noblocking"],
    ["PLAY", "KLM", 10],
    ["PLAY", "N", -1],
  ]
};

class DiceRoll {
  constructor(times, sides, bonus=0) {
    this.times = times;
    this.sides = sides;
    this.bonus = bonus;
  }

  roll() {
    let result = 0;
    for (let i = this.times; i--;) {
      result += randomBetween(1, this.sides+1)|0;
    }
    return result + this.bonus;
  }
}

class UniformRoll {
  constructor(from, to, bonus=0) {
    this.from = from;
    this.to = to;
    this.bonus = bonus;
  }

  roll() {
    return (randomBetween(this.from, this.to + 1)|0) + this.bonus;
  }
}

const WEAPON_PICKUP_SOUND = "DSWPNUP";
const POWERUP_PICKUP_SOUND = "DSGETPOW";
const ITEM_PICKUP_SOUND = "DSITEMUP";
function playSound(name) {
  let sound = Resources.get(ANYDOOM).getSound(name);
  if (sound) sound.play();
}

const ANYDOOM = ["doom.wad", "doom2.wad", "freedoom2.wad"];
const OGDOOMS = ["doom.wad", "doom2.wad"];

const Weapons = {
  Shotgun: {
    name: "Shotgun",
    projectile: "GenericBullet",
    horizontalSpread: 12,
    verticalSpread: 3,
    damage: new UniformRoll(1, 2),
    bulletsPerShot: 5,
    shots: 1,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSSHOTGN"
  },
  PlasmaGun: {
    name: "Plasma Gun",
    projectile: "PlasmaBall",
    horizontalSpread: 4,
    verticalSpread: 4,
    damage: new UniformRoll(1, 3),
    bulletsPerShot: 1,
    shots: 4,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSPLASMA"
  },
  Minigun: {
    name: "Minigun",
    projectile: "GenericBullet",
    horizontalSpread: 8,
    verticalSpread: 8,
    damage: new UniformRoll(1, 2),
    bulletsPerShot: 1,
    shots: 9,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSPISTOL"
  },
  Rifle: {
    name: "Rifle",
    projectile: "GenericBullet",
    horizontalSpread: 5,
    verticalSpread: 5,
    damage: new UniformRoll(2, 4),
    bulletsPerShot: 1,
    shots: 1,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSPISTOL"
  },

  ImpBall: {
    name: "Imp Ball",
    projectile: "ImpBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(2, 4),
    bulletsPerShot: 1,
    shots: 1,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSFIRSHT"
  },
  SerpentipedeBall: {
    name: "Serpentipede Ball",
    projectile: "SerpentipedeBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(2, 4),
    bulletsPerShot: 1,
    shots: 1,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSFIRSHT"
  },
  BaronBall: {
    name: "Baron Ball",
    projectile: "BaronBall",
    horizontalSpread: 7,
    verticalSpread: 4,
    damage: new UniformRoll(3, 7),
    bulletsPerShot: 2,
    shots: 1,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSFIRSHT"
  },
  HellKnightBall: {
    name: "Hell Knight Ball",
    projectile: "HellKnightBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 1,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSFIRSHT"
  },
  PainBringerBall: {
    name: "Pain Bringer Ball",
    projectile: "PainBringerBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 1,
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSFIRSHT"
  },
  PinkyBite: {
    name: "Bite",
    projectile: null,
    isMelee: true,
    damage: new UniformRoll(3, 5),
    attackSoundFrom: ANYDOOM,
    attackSoundName: "DSSGTATK"
  }
}

const ActorDefs = {
  FreedoomGuy: {
    name: "Freedoom Guy",
    from: ["freedoom2.wad"],
    sideOverride: SIDE_PLAYER,
    hp: 21,
    travelRange: 4,

    painSoundName: "dsplpain",
    deathSoundName: "dspldeth",

    rawAnims: PlayerRaws,
    weapons: [
      Weapons.Rifle
    ]
  },

  DoomGuy: {
    name: "Doom Guy",
    from: ["doom.wad", "doom2.wad"],
    replaceWith: "FreedoomGuy",
    sideOverride: SIDE_PLAYER,
    hp: 21,
    travelRange: 4,

    painSoundName: "dsplpain",
    deathSoundName: "dspldeth",

    rawAnims: PlayerRaws,
    weapons: [
      Weapons.Rifle
    ]
  },

  PlasmaBall: {
    name: "Plasma Ball",
    from: ["doom.wad", "doom2.wad", "freedoom2.wad"],
    speed: 18,
    isProjectile: true,
    fullbright: true,

    deathSoundName: "dsfirxpl",

    rawAnims: {
      idleAnim: [
        ["PLSS", "AB", 5]
      ],
      deathAnim: [
        ["PLSE", "ABCDE", 4]
      ]
    }
  },

  ZombieMan: {
    name: "Former Human",
    from: ["doom.wad", "doom2.wad", "freedoom2.wad"],
    travelRange: 3,
    hp: 7,

    sightSoundName: ["dsposit1", "dsposit2", "dsposit3"],
    activeSoundName: "dsposact",
    painSoundName: "dspopain",
    deathSoundName: ["dspodth1", "dspodth2", "dspodth3"],

    rawAnims: {
      idleAnim: [
        ["POSS", "AB", 12]
      ],
      walkAnim: [
        ["POSS", "ABCD", 4, "travel"]
      ],
      attackAnim: [
        ["POSS", "E", 8],
        ["POSS", "F", 8, "attack"],
        ["POSS", "E", 8],
      ],
      attackAnimBurst: [
        ["POSS", "E", 4],
        ["POSS", "F", 4, "attack"],
      ],
      painAnim: [
        ["POSS", "G", 8, "pain"]
      ],
      deathAnim: [
        ["POSS", "H", 5],
        ["POSS", "I", 5, "deathscream"],
        ["POSS", "J", 5, "noblocking"],
        ["POSS", "K", 5],
        ["POSS", "L", -1],
      ]
    },
    weapons: [
      Weapons.Rifle
    ]
  },

  ShotgunGuy: {
    name: "Former Human Sergeant",
    from: ["doom.wad", "doom2.wad", "freedoom2.wad"],
    travelRange: 3,
    hp: 9,

    sightSoundName: ["dsposit1", "dsposit2", "dsposit3"],
    activeSoundName: "dsposact",
    painSoundName: "dspopain",
    deathSoundName: ["dspodth1", "dspodth2", "dspodth3"],

    rawAnims: {
      idleAnim: [
        ["SPOS", "AB", 12]
      ],
      walkAnim: [
        ["SPOS", "ABCD", 4, "travel"]
      ],
      attackAnim: [
        ["SPOS", "E", 8],
        ["SPOS", "F", 8, "attack"],
        ["SPOS", "E", 8],
      ],
      attackAnimBurst: [
        ["SPOS", "E", 4],
        ["SPOS", "F", 4, "attack"],
      ],
      painAnim: [
        ["SPOS", "G", 8, "pain"]
      ],
      deathAnim: [
        ["SPOS", "H", 5],
        ["SPOS", "I", 5, "deathscream"],
        ["SPOS", "J", 5, "noblocking"],
        ["SPOS", "K", 5],
        ["SPOS", "L", -1],
      ]
    },
    weapons: [
      Weapons.Shotgun
    ]
  },

  FleshWorm: {
    name: "Flesh Worm",
    from: ["freedoom2.wad"],
    hp: 12,
    travelRange: 4,

    sightSoundName: "dssgtsit",
    activeSoundName: "dsdmact",
    painSoundName: "dsdmpain",
    deathSoundName: "dssgtdth",

    rawAnims: {
      idleAnim: [
        ["SARG", "AB", 12]
      ],
      walkAnim: [
        ["SARG", "ABCD", 2, "travel"]
      ],
      attackAnim: [
        ["SARG", "EF", 8],
        ["SARG", "G", 8, "attack"],
      ],
      painAnim: [
        ["SARG", "H", 5, "pain"]
      ],
      deathAnim: [
        ["SARG", "I", 8],
        ["SARG", "J", 8, "deathscream"],
        ["SARG", "K", 4],
        ["SARG", "L", 4, "noblocking"],
        ["SARG", "M", 4],
        ["SARG", "N", -1],
      ]
    },
    weapons: [
      Weapons.PinkyBite
    ]
  },

  Pinky: {
    name: "Pinky",
    from: ["doom.wad", "doom2.wad"],
    replaceWith: "FleshWorm",
    hp: 12,
    travelRange: 4,

    sightSoundName: "dssgtsit",
    activeSoundName: "dsdmact",
    painSoundName: "dsdmpain",
    deathSoundName: "dssgtdth",

    rawAnims: {
      idleAnim: [
        ["SARG", "AB", 12]
      ],
      walkAnim: [
        ["SARG", "ABCD", 4, "travel"]
      ],
      attackAnim: [
        ["SARG", "EF", 8],
        ["SARG", "G", 8, "attack"],
      ],
      painAnim: [
        ["SARG", "H", 5, "pain"]
      ],
      deathAnim: [
        ["SARG", "I", 8],
        ["SARG", "J", 8, "deathscream"],
        ["SARG", "K", 4],
        ["SARG", "L", 4, "noblocking"],
        ["SARG", "M", 4],
        ["SARG", "N", -1],
      ]
    },
    weapons: [
      Weapons.PinkyBite
    ]
  },

  Serpentipede: {
    name: "Serpentipede",
    from: ["freedoom2.wad"],
    travelRange: 4,
    hp: 12,

    sightSoundName: ["dsbgsit1", "dsbgsit2"],
    activeSoundName: "dsbgact",
    painSoundName: "dspopain",
    deathSoundName: ["dsbgdth1", "dsbgdth2"],

    rawAnims: ImpSerpRaws,
    weapons: [
      Weapons.SerpentipedeBall
    ],
  },

  SerpentipedeBall: {
    name: "Serpentipede Ball",
    from: ["freedoom2.wad"],
    speed: 9,
    isProjectile: true,
    rawAnims: ImpSerpBallRaws
  },

  Imp: {
    name: "Imp",
    from: ["doom.wad", "doom2.wad"],
    replaceWith: "Serpentipede",
    travelRange: 4,
    hp: 12,

    sightSoundName: ["dsbgsit1", "dsbgsit2"],
    activeSoundName: "dsbgact",
    painSoundName: "dspopain",
    deathSoundName: ["dsbgdth1", "dsbgdth2"],

    rawAnims: ImpSerpRaws,
    weapons: [
      Weapons.ImpBall
    ],
  },

  ImpBall: {
    name: "Imp Ball",
    from: ["doom.wad", "doom2.wad"],
    speed: 9,
    fullbright: true,
    isProjectile: true,
    rawAnims: ImpSerpBallRaws
  },

  Baron: {
    name: "Baron of Hell",
    from: ["doom.wad", "doom2.wad"],
    replaceWith: "PainLord",
    travelRange: 4,
    hp: 36,

    sightSoundName: "dsbrssit",
    activeSoundName: "dsdmact",
    painSoundName: "dsdmpain",
    deathSoundName: "dskntdth",

    weapons: [
      Weapons.BaronBall
    ],
    rawAnims: BaronPLRaws,
  },

  PainLord: {
    name: "Pain Lord",
    from: ["freedoom.wad", "freedoom2.wad"],
    travelRange: 4,
    hp: 36,

    sightSoundName: "dsbrssit",
    activeSoundName: "dsdmact",
    painSoundName: "dsdmpain",
    deathSoundName: "dskntdth",

    weapons: [
      Weapons.BaronBall
    ],
    rawAnims: BaronPLRaws,
  },

  BaronBall: {
    name: "Baron Ball",
    from: ANYDOOM,
    fullbright: true,
    speed: 8,
    isProjectile: true,
    deathSoundName: "dsfirxpl",
    rawAnims: HKPBBallRaws,
  },

  HellKnightBall: {
    name: "Hell Knight Ball",
    from: ANYDOOM,
    fullbright: true,
    speed: 8,
    isProjectile: true,
    rawAnims: HKPBBallRaws,
  },

  HellKnight: {
    name: "Hell Knight",
    from: ["doom2.wad"],
    replaceWith: "PainBringer",
    travelRange: 4,
    hp: 24,

    sightSoundName: "dskntsit",
    activeSoundName: "dsdmact",
    painSoundName: "dsdmpain",
    deathSoundName: "dskntdth",

    weapons: [
      Weapons.HellKnightBall
    ],
    rawAnims: HKPBRaws,
  },

  HellKnightBall: {
    name: "Hell Knight Ball",
    from: ["doom2.wad"],
    fullbright: true,
    speed: 8,
    isProjectile: true,
    rawAnims: HKPBBallRaws,
  },

  PainBringer: {
    name: "Pain Bringer",
    from: ["freedoom2.wad"],
    travelRange: 4,
    hp: 24,

    sightSoundName: "dskntsit",
    activeSoundName: "dsdmact",
    painSoundName: "dsdmpain",
    deathSoundName: "dskntdth",

    weapons: [
      Weapons.PainBringerBall
    ],
    rawAnims: HKPBRaws,
  },

  PainBringerBall: {
    name: "Pain Bringer Ball",
    from: ["freedoom2.wad"],
    fullbright: true,
    speed: 8,
    isProjectile: true,
    rawAnims: HKPBBallRaws,
  },

  GenericBullet: {
    name: "Bullet",
    from: ["freedoom2.wad"],
    speed: 24,
    fullbright: true,
    isProjectile: true,
    // rawAnims: HKPBBallRaws
    rawAnims: {
      idleAnim: [
        ["PUFF", "A", 4]
      ],
      deathAnim: [
        ["PUFF", "BCD", 2]
      ]
    }
  },

  HealthBonus: {
    name: "Health Bonus",
    from: ANYDOOM,
    isItem: true,
    onpickup: (actor) => {
      if (actor.hp == actor.actordef.hp) return false;
      playSound(POWERUP_PICKUP_SOUND);
      actor.heal(4);
      return true;
    },
    rawAnims: {
      idleAnim: [
        ["BON1", "ABCDCB", 6]
      ]
    }
  },

  RedCard: {
    name: "Red Keycard",
    from: ANYDOOM,
    isItem: true,
    onpickup: (actor) => {
      if (!g_GotRedCard) {
        g_GotRedCard = true;
        showMessage("Picked up the Red Keycard. You can exit now.");
        playSound(ITEM_PICKUP_SOUND);
        return true;
      }
      return false;
    },
    rawAnims: {
      idleAnim: [
        ["RKEY", "AB", 10]
      ]
    }
  },

  ShotgunPickup: {
    name: "Shotgun",
    from: ANYDOOM,
    isItem: true,
    onpickup: (actor) => {
      actor.pickupSpecialWeapon(Weapons.Shotgun);
      playSound(WEAPON_PICKUP_SOUND);
      return true;
    },
    rawAnims: {
      idleAnim: [
        ["SHOT", "A", -1]
      ]
    }
  },

  PlasmaPickup: {
    name: "Plasma Rifle",
    from: ANYDOOM,
    isItem: true,
    onpickup: (actor) => {
      actor.pickupSpecialWeapon(Weapons.PlasmaGun);
      playSound(WEAPON_PICKUP_SOUND);
      return true;
    },
    rawAnims: {
      idleAnim: [
        ["PLAS", "A", -1]
      ]
    }
  },

  ChaingunPickup: {
    name: "Minigun",
    from: ANYDOOM,
    isItem: true,
    onpickup: (actor) => {
      actor.pickupSpecialWeapon(Weapons.Minigun);
      playSound(WEAPON_PICKUP_SOUND);
      return true;
    },
    rawAnims: {
      idleAnim: [
        ["MGUN", "A", -1]
      ]
    }
  }
}

function initWeaponDefs() {
  for (let wepn in Weapons) {
    let wep = Weapons[wepn];
    if (wep.attackSoundName) {
      wep.attackSound = Resources.get(wep.attackSoundFrom).getSound(wep.attackSoundName);
    }
  }
}

function initActorDefs() {
  function makeSounds(wadres, soundNames) {
    let results = [];
    for (let name of (soundNames instanceof Array ? soundNames : [soundNames])) {
      results.push(wadres.getSound(name));
    }
    return results;
  }

  for (let adefname in ActorDefs) {
    let adef = ActorDefs[adefname];
    let rawAnims = adef.rawAnims;
    if (adef.parsedAnims) continue; // already parsed

    let wadres = Resources.get(adef.from);
    if (!wadres) {
      console.warn("No resource WAD for actor " + adefname)
      adef.resourcesFound = false;
      continue;
    }

    if (adef.deathSoundName) adef.deathSounds = makeSounds(wadres, adef.deathSoundName);
    if (adef.painSoundName) adef.painSounds = makeSounds(wadres, adef.painSoundName);
    if (adef.sightSoundName) adef.sightSounds = makeSounds(wadres, adef.sightSoundName);
    if (adef.activeSoundName) adef.activeSounds = makeSounds(wadres, adef.activeSoundName);

    adef.resourcesFound = true;

    adef.parsedAnims = {};
    for (let rawAnimName in rawAnims) {
      let parsed = [];
      for (let part of rawAnims[rawAnimName]) {
        let i = 0;
        let base = part[i++];
        if (typeof(base) != "string") throw "Not a string";
        let frames = part[i++];
        if (typeof(frames) != "string") throw "Not a string";
        let time = part[i++];
        if (typeof(time) != "number") throw "Not a number";
        let animEvent = part[i++];

        for (let frame of frames) {
          parsed.push({
            frame: wadres.getSprite(base, frame),
            time: time,
            animEvent: animEvent,
          });
        }
      }
      adef.parsedAnims[rawAnimName] = parsed;
    }
  }

  let adp = document.querySelector("#ActorDefPicker");
  if (adp) {
    for (let ad in ActorDefs) {
      let el = document.createElement("div");
      el.className = "DefChoice";
      el.innerText = ad;
      el.onclick = () => selectActorDef(ad);
      adp.appendChild(el);
    }
  } else {
    console.error("ADP not found?");
  }
}

let g_Raycaster = new THREE.Raycaster();
let g_MousePosition = new THREE.Vector2();

let g_PlayerClicked = false;
let g_KeysPressed = [];
let g_KeysReleased = [];
window.addEventListener( 'mousemove', function ( event ) {
	// calculate mouse position in normalized device coordinates
	// (-1 to +1) for both components
	g_MousePosition.x = ( event.clientX / window.innerWidth ) * 2 - 1;
	g_MousePosition.y = - ( event.clientY / window.innerHeight ) * 2 + 1;
}, false );

{
  let mx, my;

  window.addEventListener( 'mousedown', function ( event ) {
    if (event.button == 0) {
      mx = event.screenX;
      my = event.screenY;
    }
  }, false );

  window.addEventListener( 'mouseup', function ( event ) {
    if (event.button == 0 && Math.abs(mx - event.screenX) <= 1 && Math.abs(my - event.screenY) <= 1) {
      g_PlayerClicked = true;
    }
  }, false );

  window.addEventListener( 'keydown', function (event) {
    g_KeysPressed.push(event.which);
  });

  window.addEventListener( 'keyup', function (event) {
    g_KeysReleased.push(event.which);
    if (DEV && event.which == Keys.E) {
      toggleMode(g_Mode == PLAY_MODE ? EDIT_MODE : PLAY_MODE);
    } else if (g_Mode == EDIT_MODE) {
      if (event.which == Keys.A) {
        moveEditModeGrid(+1);
      } else if (event.which == Keys.Z) {
        moveEditModeGrid(-1);
      }
    }
  }, false);
}

function loadSpriteFromWad(wad, sprite, frame) {
  let sprname = sprite;
  let s = frame;

  let results = [];

  for (let f = 0; f <= 8; f++) {
    let graphic = Object.create(Graphic);

    let flip = false;
    let lump = wad.getLumpByName(sprname + s + f);
    if (!lump) {
      switch(f) {
      case 5: flip = true; case 1: lump = wad.getLumpByName(sprname + s + 1 + s + 5); break;
      case 8: flip = true; case 2: lump = wad.getLumpByName(sprname + s + 2 + s + 8); break;
      case 7: flip = true; case 3: lump = wad.getLumpByName(sprname + s + 3 + s + 7); break;
      case 6: flip = true; case 4: lump = wad.getLumpByName(sprname + s + 4 + s + 6); break;
      }
    }

    if (!lump) {
      continue;
    }

    graphic.load(lump);

    let canvas = graphic.toCanvas(wad); // Export the image to a HTML5 canvas
    let ctx = canvas.getContext("2d");

    if (false && (graphic.xOffset || graphic.yOffset)) {
      let nc = graphic.toCanvas(wad);
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 512 //graphic.xOffset * 3
      canvas.height = 512 // graphic.yOffset * 3
      //ctx.translate(-graphic.xOffset * 3 + graphic.width * 3 / 2, 200 - graphic.yOffset * 3);
      ctx.translate(200 - graphic.xOffset * 3, 200 - graphic.yOffset * 3);
      ctx.drawImage(nc, 0, 0);
    }

    if (flip) {
      let nc = graphic.toCanvas(wad);
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(-1, 1);
      ctx.drawImage(nc, -canvas.width, 0);
    }

    if (!isPowerOfTwo(canvas.width) || !isPowerOfTwo(canvas.height)) {
      let nc = graphic.toCanvas(wad);
      nc.width = nextPowerOf2(nc.width);
      nc.height = nextPowerOf2(nc.height);
      let nctx = nc.getContext('2d');
      nctx.scale(nc.width / canvas.width, nc.height / canvas.height);
      nctx.drawImage(canvas, 0, 0);
      canvas = nc;
    }

    let tx = new THREE.CanvasTexture(canvas);
    tx.magFilter = THREE.NearestFilter;
    tx.needsUpdate = true;
    results.push({graphic: graphic, texture: tx});
  }

  if (!results.length) {
    console.warn("Couldn't load any sprites for " + sprite + frame);
  }
  return results;
}

let ui_CTHLabel = document.getElementById("CTHLabel");
// let ui_HPLabel = document.getElementById("HPLabel");

class CTHEstimate {
  constructor() {
    this.reset();
  }

  reset() {
    this.checks = 0;
    this.hits = 0;
    this.friendlyHits = 0;
    this.actor = null;
    this.hasDirectLOS = false;
  }

  getCTH() { return this.hits / this.checks; }
  getFriendlyCTH() { return this.friendlyHits / this.checks; }

  update(attacker, victim, attackDef, samples=25) {
    let raycaster = CTHEstimate._raycaster;
    let intersected = CTHEstimate._intersected;
    intersected.length = 0;
    let pos = new THREE.Vector3(), dir = new THREE.Vector3();

    getPosAndDirForAttack(attacker, victim, null, pos, dir);
    raycaster.set(pos, dir);
    raycaster.intersectObjects( g_World.collidables, false, intersected );
    for (let data of intersected) {
      const int = data.object;
      if (int.dtacActor === attacker || (int.dtacActor && !int.dtacActor.isAlive())) continue;
      if (int.dtacActor === victim) this.hasDirectLOS = true;
      break;
    }

    intersected.length = 0;
    for (let i = samples; i--;) {
      getPosAndDirForAttack(attacker, victim, attackDef, pos, dir);
      raycaster.set(pos, dir);

      intersected.length = 0;
      this.checks += 1;
      raycaster.intersectObjects( g_World.collidables, false, intersected );
      if (intersected.length) {
        for (const data of intersected) {
          const int = data.object;
          // if (int === p.collisionObject || int === p.owner.collisionObject || (int.dtacActor && !int.dtacActor.isAlive())) continue;
          if (int.dtacActor === attacker || (int.dtacActor && !int.dtacActor.isAlive())) continue;
          if (int.dtacActor && int.dtacActor.side == attacker.side) this.friendlyHits += 1;
          if (int.dtacActor === victim) this.hits += 1;
          break;
        }
      }
    }
  }
}
CTHEstimate._raycaster = new THREE.Raycaster();
CTHEstimate._intersected = [];
const g_CTHEstimator = new CTHEstimate();

function moveElementTo(element, position) {
  let sp = position.clone();
  toScreenspace(sp);

  element.style.left = sp.x + "px";
  element.style.top = sp.y + "px";
}

function updateActorHoverInfo(hoveredActor) {
  let ahi = byId("ActorHoverInfo");
  if (hoveredActor) {
    let pos = hoveredActor.position.clone();
    pos.y += TILE_Y * 4;
    moveElementTo(ahi, pos);
    // ui_HPLabel.innerText = `HP: ${hoveredActor.hp} / ${hoveredActor.actordef.hp}`;
  } else {
    ahi.style.left = -1000 + "px";
    ahi.style.top = -1000 + "px";
  }
}

function resetCTH(cth, resetLabel=true) {
  cth.reset();
  if (resetLabel) {
    ui_CTHLabel.innerText = "";
  }
}

function updateCTH(cth, attacker, victim, attackDef, updateLabel=true) {
  cth.update(attacker, victim, attackDef)
  if (updateLabel) {
    let text = "CTH ≈ " + Math.round(cth.getCTH() * 100) + "%";
    let friendlyCTH = Math.round(cth.getFriendlyCTH() * 100);
    if (friendlyCTH != cth.getFriendlyCTH()) text += " (" + friendlyCTH + "% friendly)";

    ui_CTHLabel.innerText = text;
  }
}

function aiAct() {
  let ai = g_World.actors.find(a => a.side == SIDE_AI && a.canAct() && a.isAlive());
  if (!ai) return;
  ai.takeAction();
  let atkDef = ai.actordef.weapons[0];
  let searchIn =
    atkDef.isMelee ?
    ai.tile.links.map(t => t.actor).filter(a => a) :
    g_World.actors;
  let tgt;
  for (let a of searchIn) {
    if (a.side != SIDE_AI && a.isAlive()) {
      if (atkDef.isMelee) {
        tgt = a;
        break;
      }
      let cth = new CTHEstimate();
      cth.update(ai, a, atkDef, 50)
      let shotMult = Math.max(((atkDef.shots || 1) + (atkDef.bulletsPerShot || 1)) * 0.75, 1);
      if (cth.hasDirectLOS && cth.getCTH() * shotMult >= 0.2 && cth.getFriendlyCTH() * shotMult < 0.25) {
        tgt = a;
        break;
      }
    }
  }

  if (tgt) {
    g_TrackedActor = ai;
    g_CurrentAction = doAttack(ai, tgt, atkDef);
  } else {
    let wantsMelee = atkDef.isMelee;
    let reachables = findReachableTiles(ai.tile, ai.travelRange);
    let t;
    if (wantsMelee) {
      let tt = choose(reachables.filter(({tile: t}) => {
        return t.links.some(t => t.actor && t.actor.isAlive() && t.actor.side != SIDE_AI);
      }));
      t = tt && tt.tile;
    }
    if (t) {
      g_TrackedActor = ai;
      g_CurrentAction = doTravel(ai, findPath(ai.tile, t).path);
    } else {
      let shortestPath;
      for (let actor of g_World.actors) {
        if (actor.isAlive() && actor.side != SIDE_AI) {
          let {path, found} = findPath(ai.tile, actor.tile);
          if (!shortestPath || (path.length < shortestPath.length)) shortestPath = path;
        }
      }

      if (shortestPath) {
        shortestPath.shift();
        shortestPath.length = Math.min(ai.travelRange, shortestPath.length);

        g_TrackedActor = ai;
        g_CurrentAction = doTravel(ai, shortestPath);
      }
    }
  }
}

function updateSelectedActorUI() {
  let actor = g_SelectedActor;
  let el = document.body.querySelector(".SelectedActorInfo");
  let hp = el.querySelector(".HPValue")
  let wep = el.querySelector(".WeaponValue")
  let actions = el.querySelector(".ActionsValue")

  hp.innerText = (actor ? actor.hp + " / " + actor.maxHp : "N/A");
  let wepstr = "";
  if (actor) {
    wepstr += actor.getWeapon().name;
    wepstr += ` (`
    if (actor.specialWeapon && actor.getWeapon() == actor.specialWeapon.def) {
      wepstr += `${actor.specialWeapon.shots} shots left`;
    } else {
      wepstr += 'unlimited ammo';
    }
    wepstr += ')';
  }
  wep.innerText = wepstr;
  actions.innerText = (actor ? `${actor.actionsLeft} / ${actor.maxActions}` : "N/A");
}

function showMessage(msg, timeout=3000) {
  let el = document.querySelector(".SomeMessage");
  if (el) {
    el.innerText = msg;
    el.style.opacity = 1.0;
    setTimeout(() => {
      el.style.opacity = 0.0;
    }, timeout);
  }
}

function playerSelectActor(actor) {
  if (actor && actor.actionsLeft == 0) {
    showMessage("No actions left.");
    return false;
  }
  g_SelectedActor = actor;
  g_TrackedActor = actor;
  g_MainCameraLerping = true;
  g_SelectedActorReachables = null;
  updateSelectedActorUI();
  resetCTH(g_CTHEstimator);
}

function anyEnemiesDiscovered() {
  for (let a of g_World.actors) {
    if (a.side == SIDE_AI && a.isAlive() && !a.isItem && a.discovered) return true;
  }
  return false;
}

let oldReachables = [];
function playerAct() {
  if (!g_SelectedActor || !g_SelectedActor.canAct() || !g_SelectedActor.isAlive()) {
    playerSelectActor(g_World.actors.find(
      a => a.side == SIDE_PLAYER && a.canAct() && a.isAlive()));
  }

  if (!g_SelectedActor) return;
  // g_TrackedActor = g_SelectedActor;

  let reachables = findReachableTiles(g_SelectedActor.tile, g_SelectedActor.travelRange);
  for (let {tile: t} of reachables) {
    for (let obj of t.walkableObjects) {
      let oldMat = obj.material;
      obj.material = walkableObjectMaterial;
      oldReachables.push([obj, oldMat]);
    }
  }

  g_Raycaster.setFromCamera( g_MousePosition, g_MainCamera );
  let intersects = g_Raycaster.intersectObjects( g_World.pickable );
  for (let i = 0; i < intersects.length; i++) {
    let obj = intersects[ i ].object;
    if (obj.dtacTile && reachables.some(r => r.tile === obj.dtacTile)) {
      let pos = obj.dtacTile.object.position.clone();
      pos.y += 0.02;
      showHoverCursorAt(pos, 0xffff00);
      let {path: p, found} = findPath(g_SelectedActor.tile, obj.dtacTile);

      if (g_PlayerClicked && found && p[p.length-1] == obj.dtacTile) {
        p.shift();
        let a = obj.dtacTile.actor;
        if (a && a.isAlive() && a !== g_SelectedActor) {
          let atkDef = g_SelectedActor.getWeapon();
          g_CurrentAction = doAttack(g_SelectedActor, a, atkDef, g_SelectedActor.specialWeapon);
        } else {
          g_CurrentAction = doTravel(g_SelectedActor, p);
        }
        if (anyEnemiesDiscovered()) g_SelectedActor.takeAction();
      }
      return;
    } else if (obj.dtacActor && obj.dtacActor.isAlive() && obj.dtacActor.discovered && !obj.dtacActor.actordef.isItem) {
      let a = obj.dtacActor;
      updateActorHoverInfo(a);
      if (a.side == SIDE_PLAYER) {
        showHoverCursorAt(a.position, 0x00ff00);
        if (g_PlayerClicked) playerSelectActor(a);
      } else if (a.isAlive()) {
        showHoverCursorAt(a.position, 0xff0000);

        if (g_PlayerClicked) {
          let atkDef = g_SelectedActor.getWeapon();
          g_CurrentAction = doAttack(g_SelectedActor, a, atkDef, g_SelectedActor.specialWeapon);
          if (anyEnemiesDiscovered()) g_SelectedActor.takeAction();
        } else {
          if (a !== g_CTHEstimator.actor) {
            resetCTH(g_CTHEstimator);
            g_CTHEstimator.actor = a;
          }
          let atkDef = g_SelectedActor.getWeapon();
          updateCTH(g_CTHEstimator, g_SelectedActor, a, atkDef);
        }
      }
      return;
    } else {
      resetCTH(g_CTHEstimator);
    }
  }
}

function saveMapdef(copyToClipboard=true) {
  let mapdefstr = JSON.stringify(g_World.mapdef);
  localStorage.setItem("testmapdef", mapdefstr);
  console.info("Saved! " + mapdefstr.length + ")");
  if (copyToClipboard) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var text = "Example text to appear on clipboard";
      navigator.clipboard.writeText(mapdefstr).then(function() {
        alert('Async: Copying to clipboard was successful!');
      }, function(err) {
        alert('Async: Could not copy text: ', err);
      });
    }
  } else {
    alert("Clipboard API unavailable");
  }
}

function loadMapdef() {
  let mapdef = JSON.parse(localStorage.getItem("testmapdef"));
  if (mapdef) console.info("Loaded!");
  return mapdef;
}

let g_ActorHoverCursor = (() => {
  let box = new THREE.BoxGeometry(1, 1.2, 1);
  box.translate(0, 0.6, 0);
  let geom = new THREE.EdgesGeometry( box );
  let mat = new THREE.LineBasicMaterial({color: 0x00ff00, linewidth: 3, transparent: true, opacity: 0.25});
  mat.needsUpdate = true;
  return new THREE.LineSegments(geom, mat);
})();

function hideHoverCursor() {
  g_ActorHoverCursor.visible = false;
}

function showHoverCursorAt(position, colorHex) {
  g_ActorHoverCursor.visible = true;
  g_ActorHoverCursor.position.copy(position);
  let {x, y, z} = position;
  byId("CursorLoc").innerText = `${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`;
  if (colorHex !== undefined) g_ActorHoverCursor.material.color.set(colorHex);
}

let g_SelectedActor;
let g_TrackedActor;
let g_MainCameraLerping = false;
let g_FirstLerp = true;
let g_TurnCount = 0;

const PLAY_MODE = 0, EDIT_MODE = 1, MAIN_MENU_MODE = 2, END_MODE = 3;
let g_Mode = MAIN_MENU_MODE;

const GRID_Y_OFFSET = 0.015;
let g_EditModeGrid = new THREE.Group();
let g_EditModeGridY = 8;
let g_EditModeGridHelper = new THREE.GridHelper(32, 32, 0xff0000, 0xffff00);
let g_EditModeGridPlane = new THREE.Mesh((new THREE.PlaneGeometry(32, 32)).rotateX(THREE.Math.degToRad(-90)));
{
  g_EditModeGrid.add(g_EditModeGridHelper);
  g_EditModeGrid.add(g_EditModeGridPlane);
  g_EditModeGridPlane.material.visible = false;
  // g_EditModeGridHelper.position.y += GRID_Y_OFFSET;
  g_EditModeGrid.position.x -= 0.5 - 16;
  g_EditModeGrid.position.z -= 0.5 - 16;
}

function moveEditModeGrid(by) {
  g_EditModeGridY = THREE.Math.clamp(g_EditModeGridY + Math.round(by), 0, 32);
  g_EditModeGrid.position.y = g_EditModeGridY * TILE_Y + GRID_Y_OFFSET;
  g_MainCameraControls.target.y = g_EditModeGrid.position.y;
  // g_MainCamera.position.y = g_EditModeGridY * TILE_Y + GRID_Y_OFFSET + 12.5;
}

function toggleMode(newmode) {
  removePreviewTile();
  document.body.classList.remove("edit-mode");
  document.body.classList.remove("play-mode");
  document.body.classList.remove("main-menu");
  document.body.classList.remove("end-mode");
  g_World.scene.remove(g_EditModeGrid);
  if (newmode == PLAY_MODE) {
    document.body.classList.add("play-mode");
    g_Mode = PLAY_MODE;
    g_World.actordefPreviews.forEach(a => a.object.visible = false);
    g_World.actors.forEach(a => a.object.visible = true);
  } else if (newmode == EDIT_MODE) {
    document.body.classList.add("edit-mode");
    if (g_EditModeSelectedDefType == "tile") resetPreviewTile();
    g_World.scene.add(g_EditModeGrid);
    g_World.actordefPreviews.forEach(a => a.object.visible = true);
    g_World.actors.forEach(a => a.object.visible = false);
    g_Mode = EDIT_MODE;
    moveEditModeGrid(0);
  } else if (newmode == END_MODE) {
    document.body.classList.add("end-mode");
    g_Mode = END_MODE;
  } else {
    throw "Unknown mode: " + g_Mode;
  }
}

function addPart(parts, part) {
  if (!parts.find(p => p.def == part.def && p.rotationY == part.rotationY)) {
    parts.push(part);
  }
}

function justPressedKey(key) {
  return g_KeysPressed.indexOf(key) !== -1;
}

let g_EditModeRot = ROT0;
let g_EditModeSelectedDefType = null;
let g_EditModeSelectedDef = null;
let g_EditModePreviewTile = null;
function removePreviewTile() {
  if (g_EditModePreviewTile) {
    g_World.scene.remove(g_EditModePreviewTile.object);
    g_EditModePreviewTile = null;
  }
}

function resetPreviewTile() {
  removePreviewTile();
  if (g_EditModeSelectedDef === null) {
    for (let def in TileModelDefs) { selectTileDef(def); break; }
  }
  if (g_EditModeSelectedDef === null) {
    throw "No defs?";
  }
  let td = {parts: [{def: g_EditModeSelectedDef, rotationY: g_EditModeRot}], things: []}
  let t = g_EditModePreviewTile = new DTTile(td, 0, 0, 0);
  g_World.scene.add(t.object);
}

function selectTileDef(newdef) {
  removePreviewTile();
  g_EditModeSelectedDef = newdef;
  g_EditModeSelectedDefType = "tile";
  resetPreviewTile();
}

function selectActorDef(newdef) {
  removePreviewTile();
  g_EditModeSelectedDef = newdef;
  g_EditModeSelectedDefType = "actor";
}

function editMode(dt) {
  g_World.actordefPreviews.forEach(actor => actor.update(dt));

  g_Raycaster.setFromCamera( g_MousePosition, g_MainCamera );
  let intersects = g_Raycaster.intersectObject(g_EditModeGridPlane);
  if (intersects.length) {
    let {point} = intersects[0];
    let {x, y, z} = point;
    x = ((x + 0.5) | 0);
    z = ((z + 0.5) | 0);
    point.set(x, y, z);
    let tx = Math.round(x / TILE_X);
    let ty = Math.round(y / TILE_Y);
    let tz = Math.round(z / TILE_Z);

    if (justPressedKey(Keys.X)) {
      let td = g_World.mapdef.tiles[XYZtoID(tx, ty, tz)];
      if (td) {
        td.parts = [];
        g_World.setTileFromDef(tx, ty, tz, td);
        g_World.createTileLinks(tx, ty, tz);
      }
    }

    if (justPressedKey(Keys.C)) {
      let td = g_World.mapdef.tiles[XYZtoID(tx, ty, tz)];
      if (td) {
        td.actor = null;
        g_World.setTileFromDef(tx, ty, tz, td);
        g_World.createTileLinks(tx, ty, tz);
      }
    }

    if (justPressedKey(Keys.G)) {
      g_Raycaster.setFromCamera(g_MousePosition, g_MainCamera);
      let intersects = g_Raycaster.intersectObjects(g_World.walkable);
      if (intersects.length) {
        let {dtacTile} = intersects[0].object;
        if (dtacTile) {
          // g_EditModeGrid.position.y = dtacTile.position.y;
          moveEditModeGrid((dtacTile.position.y / TILE_Y) - g_EditModeGridY);
        }
      }
    }

    if (justPressedKey(Keys.NUM5)) {
      saveMapdef();
    }

    if (justPressedKey(Keys.NUM9)) {
      let md = loadMapdef();
      if (md) {
        g_World.mapdef = md;
        g_World.initMap();
      };
    }

    if (justPressedKey(Keys.R)) {
      g_EditModeRot += 1;
      g_EditModeRot %= MAX_ROT+1;
      if (g_EditModeSelectedDefType == "tile") resetPreviewTile();
    }

    if (justPressedKey(Keys.F)) {
      let td = g_World.mapdef.tiles[XYZtoID(tx, ty, tz)];
      if (!td) td = g_World.mapdef.tiles[XYZtoID(tx, ty, tz)] = {
        x: tx,
        y: ty,
        z: tz,
        parts: [],
        things: []
      }

      if (g_EditModeSelectedDefType == "tile") {
        addPart(td.parts, {def: g_EditModeSelectedDef, rotationY: g_EditModeRot});
      } else if (g_EditModeSelectedDefType == "actor") {
        td.actor = {def: g_EditModeSelectedDef, rotationY: g_EditModeRot};
      } else {
        throw "Invalid def type: " + g_EditModeSelectedDefType;
      }

      g_World.setTileFromDef(tx, ty, tz, td);
      g_World.createTileLinks(tx, ty, tz);
    };

    if (g_EditModePreviewTile) {
      g_EditModePreviewTile.setPosition(tx, ty, tz);
    }

    // console.log(x, Math.round(y * 4), z);
    showHoverCursorAt(point);
  }
}

function endGame(message) {
  let el = document.querySelector(".EndGameMessage");
  if (el) el.innerText = message || "Game Over";
  toggleMode(END_MODE);
}

const CAM_OFFSET = new THREE.Vector3(-16, 21, -16);
let g_DidIntro = false;
function* doIntro() {
  let keypos = new THREE.Vector3(15, 4, 20);
  let exitpos = new THREE.Vector3(31, 2, 2)
  yield* doWait(0.5);

  for (let [nextpos, spd, msg] of [[keypos, 4, "Grab the Red Keycard..."], [exitpos, 5, "...and get to the exit area."]]) {
    let t = nextpos;
    showMessage(msg, 10000);
    while (!almostEqual(g_MainCameraControls.target, t, 0.1)) {
      let dt = yield;
      moveTowards(g_MainCameraControls.target, t, dt * spd);
      let g = g_MainCameraControls.target.clone();
      g.add(CAM_OFFSET);
      moveTowards(g_MainCamera.position, g, dt * spd);
    }
    doWait(3.5);
  }
  doWait(2.5);
}

function playMode(dt) {
  if (!g_CurrentAction && !g_DidIntro) {
    g_CurrentAction = doIntro();
  }

  let justFinishedAnAction = false;
  if (g_CurrentAction) {
    resetCTH(g_CTHEstimator);
    let r = g_CurrentAction.next(dt);
    if (r.done) {
      g_DidIntro = true;
      g_CurrentAction = null;
      justFinishedAnAction = true;
    }
  }

  let allDead = true;
  let allOnExit = true;
  for (let a of g_World.actors) {
    if (a.side == SIDE_PLAYER) {
      if (a.isAlive()) {
        allDead = false;
        if (!a.tile.isExit) {
          allOnExit = false;
          break;
        }
      }
    }
  }

  if (allDead) {
    endGame("Game Over");
    return;
  }

  if (allOnExit) {
    if (g_GotRedCard) {
      endGame("A winner is you!");
      return;
    } else {
      showMessage("You need the Red Keycard to exit.")
    }
  }


  if (g_CurrentSide == SIDE_PLAYER) {
    updateSelectedActorUI();
    if (justFinishedAnAction && !anyEnemiesDiscovered()) {
      for (let a of g_World.actors) {
        if (a.side == SIDE_PLAYER && a.isAlive) {
          a.resetActions();
        }
      }
    }
  }

  if (!g_CurrentAction || justFinishedAnAction) {
    let allActed = true;
    for (let a of g_World.actors) {
      if (!a.isProjectile && a.side == g_CurrentSide && a.isAlive() && a.canAct()) {
        allActed = false;
        break;
      }
    }

    if (allActed) {
      g_TurnCount += 1;
      g_CurrentSide = g_CurrentSide === SIDE_PLAYER ? SIDE_AI : SIDE_PLAYER;

      if (g_CurrentSide == SIDE_PLAYER) {
        document.body.classList.remove("enemy-turn")
      } else {
        document.body.classList.add("enemy-turn")
      }

      for (let a of g_World.actors) {
        a.resetActions();
      }
    }

    if (g_CurrentSide == SIDE_AI) {
      aiAct();
    } else {
      if (justFinishedAnAction && g_SelectedActor && g_SelectedActor.canAct()) {
        playerSelectActor(g_SelectedActor);
      }
      playerAct();
    }
  }

  if (g_DidIntro && (g_MainCameraLerping || g_CurrentAction)) {
    g_MainCameraLerping = true;

    const PAN = 8, ROTATE = 3;
    const camState = g_MainCameraControls.getState();

    if (this.initOffset === undefined || g_MainCameraControlsZoomChanged || camState & ROTATE) {
      this.initOffset = g_MainCamera.position.clone().sub(g_MainCameraControls.target)
    };

    //let p = g_SelectedActor && g_SelectedActor.isAlive() ? g_SelectedActor.object.position.clone() : new THREE.Vector3();
    let a = g_TrackedActor || g_SelectedActor;
    let p = a ? a.object.position.clone() : new THREE.Vector3();
    if (a && a.actordef.isProjectile) p.y -= ACTOR_EYES; // 0.5;
    g_MainCameraControls.target.lerp(p, 5 * dt);
    let t = p.clone();
    t.add(this.initOffset);
    g_MainCamera.position.lerp(t, 5 * dt);
    if (camState & PAN || almostEqual(g_MainCamera.position, t, 0.1)) {
      g_MainCameraLerping = false;
      this.initOffset = undefined;
    };
  }

  g_World.actors.forEach(actor => actor.update(dt));
}

let g_LastCurrentTime = undefined;
function mainLoop(currentTime) {
  let dt = (g_LastCurrentTime ? currentTime - g_LastCurrentTime : 0) / 1000.0;
  g_LastCurrentTime = currentTime;
  requestAnimationFrame( mainLoop );

  updateActorHoverInfo(null);
  updateDamagePopups(dt);

  for (let [obj, oldMat] of oldReachables) {
    obj.material = oldMat;
  }
  oldReachables.length = 0;
  hideHoverCursor();

  if (g_Mode == PLAY_MODE) {
    playMode(dt);
  } else if (g_Mode == MAIN_MENU_MODE) {

  } else if (g_Mode == EDIT_MODE) {
    editMode(dt);
  }
  g_PlayerClicked = false;

  g_MainCameraControlsZoomChanged = false;
  g_MainCameraControls.update();

  if (g_Mode != END_MODE) g_Renderer.render( g_World.scene, g_MainCamera );

  g_KeysPressed.length = 0;
  g_KeysReleased.length = 0;
}

function nextPowerOf2(x) {
  return Math.pow(2,Math.floor(Math.log(x)/Math.log(2)))
}

function isPowerOfTwo(x)
{
    return (x & (x - 1)) == 0;
}
