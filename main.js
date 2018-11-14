const PriorityQueue = require("js-priority-queue");
const {Keys} = require("./keys.js");
const {degToRad, radToDeg} = THREE.Math;

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
  array[idx] = array[array.length-1];
  array.pop();
  return item;
}

const BASE_WAD = "freedoom2.wad";
let g_Renderer;
let g_World;
let g_MainCamera;
let g_MainCameraControls, g_MainCameraControlsZoomChanged;
let g_CurrentAction;

const Resources = {
  wads: {},

  loadWadFromURL: function(url, as) {
    if (as === undefined) {
      as = url.split("/")
      as = as[as.length-1]
    }

    as = as.toLowerCase();

    let wadLocal = Object.create(Wad); // Create a new WAD object to load our file into
    let that = this;

    return new Promise(function(resolve, reject) {
      wadLocal.onProgress = function() {
        console.info("Loading [" + url + "]...");
      }
      wadLocal.onLoad = function() {
        window.wad = wadLocal; // write to global because wadjs is buggy
        if (wadLocal.errormsg) {
          alert("Couldn't load WAD: " + wadLocal.errormsg);
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

function start() {
  Resources.loadWadFromURL(BASE_WAD).then(
    function() {
      return Resources.loadWadFromURL("doom.wad");
    },
    function() {
      let err = `Couldn't load base wad! ( + ${BASE_WAD} + )`;
      console.error(err);
      document.body.appendChild(err);
    }
  )
  // Promise.all([
  //   Resources.loadWadFromURL(BASE_WAD)
  // ])
  .then(
    function() {
      let renderer = g_Renderer = new THREE.WebGLRenderer();
      renderer.setSize( window.innerWidth * 1.0, window.innerHeight * 1.0);
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap; // default THREE.PCFShadowMap
      document.body.appendChild( renderer.domElement );

      prepareActorDefs();
      initTileModelDefs();

      g_World = new DTWorld();
      g_MainCamera = new THREE.PerspectiveCamera( 20, window.innerWidth / window.innerHeight, 0.1, 1000 );
      g_MainCamera.position.x = 24;
      g_MainCamera.position.z = 24;
      g_MainCamera.position.y = 12.5;
      g_MainCameraControls = new THREE.MapControls( g_MainCamera );
      g_MainCameraControls.target.set(8, 0, 8);
      g_MainCameraControls.onBeforeUpdate = function() {
        if (g_MainCameraControls._changedZoom()) g_MainCameraControlsZoomChanged = true;
      }
      // g_MainCameraControls = new THREE.OrbitControls( g_MainCamera );
      mainLoop();
    },
    function() {
      let err = "Couldn't load base wad! (" + BASE_WAD + ")";
      console.error(err);
      document.body.appendChild(err);
    }
  );
}
start();

class DTWadResource {
  constructor(wadjs) {
    this.wadjs = wadjs;
    this.graphics = [];
    this.sprites = [];
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
function rotDir(rot, dir) {
  if (rot < ROT0 || rot > MAX_ROT) throw "Invalid rot " + rot;
  if (dir < NORTH || dir > MAX_DIR) throw "Invalid dir " + dir;
  dir += rot;
  return dir % (MAX_DIR+1);
}

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
  return new THREE.PlaneGeometry(1.0, 0.25).translate(0.0, 0.125, -0.5);
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
  return new THREE.PlaneGeometry(1.0, 1.0).translate(0.0, 0.5, -0.5);
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
  return new THREE.PlaneGeometry(1.0, 2.0).translate(0.0, 0.125, -0.5);
}

function FloorGeom() {
  return new THREE.PlaneGeometry(1, 1).rotateX(degToRad(-90));
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
    walkable: true
  },

  BrownFullWall1: {
    geom: Full1(),
    scaleS: 1.0,
    scaleT: 0.25,
    matn: "WALL03_4",
    blocks: [SOUTH]
  },
  BrownFullWall4: {
    geom: Full4(),
    scaleS: 1.0,
    scaleT: 1.0,
    matn: "WALL03_4",
    blocks: [SOUTH]
  },

  CompsHalfSide: {
    geom: new THREE.BoxGeometry(1.0, 0.5, 0.25).translate(0.0, 0.25, 0.5),
    scaleS: 2.0,
    scaleT: 1.0,
    matn: "COMP02_3",
    blocks: [SOUTH]
  },
  CompsTall1: {
    geom: new THREE.BoxGeometry(1.0, 2.0, 1).translate(0.0, 1.0, 0.0),
    scaleS: 1.0,
    scaleT: 2.0,
    matn: "COMP02_3",
    blocks: ALLDIRS
  },
  CompsTall4: {
    geom: new THREE.BoxGeometry(1.0, 2.0, 1).translate(0.0, 1.0, 0.0),
    scaleS: 1.0,
    scaleT: 2.0,
    matn: "COMP02_3",
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
    t.mat = texMat(t.matn);
  }

  let tdp = document.querySelector("#TileDefPicker");
  if (tdp) {
    for (let td in TileModelDefs) {
      let el = document.createElement("div");
      el.className = "TileDefChoice";
      el.innerText = td;
      el.onclick = () => selectTileDef(td);
      tdp.appendChild(el);
    }
  } else {
    console.error("TDP not found?");
  }
}

// const MapDef = {
//   tiles: {
//     XYZtoID(0, 0, 0): {
//     x: 0,
//     y: 0,
//     z: 0,
//     parts: [
//       {def: TileDefs.FloorHexes, rotationY: 0},
//       {def: TileDefs.HalfSideComps, rotationY: ROT90},
//     ],
//     things: [
//       {type: "spawn", what: "DoomImp"},
//     ]
//   }]
// }

class DTTileModel {
  constructor(geom, material, walkableGeom) {
    this.geom = geom;
    this.material = material;
    this.walkableGeom = walkableGeom;
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
  return p;
}

function* doProcessProjectile(p) {
  let raycaster = new THREE.Raycaster();
  let oldPos = new THREE.Vector3();
  while(p.isAlive()) {
    let dt = yield;

    if (!g_World.isWithinBounds(p.position)) {
      p.die();
      break;
    }

    oldPos.copy(p.position);
    let step = p.actordef.speed * dt
    let to = p.travelDirection.clone().multiplyScalar(step).add(p.position)
    moveTowards(p.position, to, step);
    let dist = step;
    raycaster.far = dist;
    raycaster.set(p.position, p.travelDirection.clone().normalize());
    let intersected = raycaster.intersectObjects( g_World.collidables );
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

function getPosAndDirForAttack(actor, victim, attackDef, pos, dir) {
  let ret = !(pos && dir);
  pos = pos ? pos.copy(actor.position) : actor.position.clone();
  pos.y += 0.75;
  dir = (dir ? dir.copy(victim.position) : victim.position.clone()).sub(pos);
  dir.y += 0.75;
  dir.normalize();

  let mx = getPosAndDirForAttack.mx.lookAt(dir, new THREE.Vector3(0,0,0), new THREE.Vector3(0,1,0));
  dir.set(0, 0, 1);
  let {horizontalSpread: hs, verticalSpread: vs} = attackDef;
  dir.applyEuler(new THREE.Euler(
    THREE.Math.degToRad(randomBetween(-vs, vs+1)),
    THREE.Math.degToRad(randomBetween(-hs, hs+1)),
    0));
  dir.applyMatrix4(mx);

  pos.add(dir.clone().multiplyScalar(0.25));

  if (ret) return [pos, dir];
}
getPosAndDirForAttack.mx = new THREE.Matrix4();

function* doWait(time) {
  while(time > 0) time -= yield;
}

function* doAttack(actor, victim, attackDef) {
  if (actor === victim) {
    console.error("An actor can't attack itself");
    return;
  }
  yield* doFaceTowards(actor, victim.position, DEFAULT_ROTATION_SPEED);
  //actor.playAnim("attackAnim", false);

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
const TILE_X = 1.0, TILE_Y = 0.25, TILE_Z = 1.0;
class DTTile {
  constructor(tiledef, x, y, z) {
    let {parts, things} = tiledef;

    this.object = new THREE.Group();

    this.blocked = [];

    this.renderObjects = [];
    this.walkableObjects = [];
    for (let part of parts) {
      let tmd = TileModelDefs[part.def];
      let rot = "rotationY" in part ? part.rotationY : ROT0;
      let r = ROTtoRads(rot);
      for (let blockDir of tmd.blocks || []) {
        let d = rotDir(rot, blockDir);
        if (this.blocked.indexOf(d) == -1) this.blocked.push(d);
      }
      let renderObject = new THREE.Mesh(tmd.geom, tmd.mat);
      renderObject.rotateY(r);
      renderObject.dtacTile = this;
      this.renderObjects.push(renderObject);
      // if (tiledef.walkableGeom) {
      if (tmd.walkable) {
        // walkableObject = new THREE.Mesh(tiledef.walkableGeom, walkableObjectMaterialInvisible);
        let walkableObject = new THREE.Mesh(tmd.geom, walkableObjectMaterialInvisible);
        walkableObject.rotateY(r);
        walkableObject.position.y += 0.01;
        walkableObject.dtacTile = this;
        this.walkableObjects.push(walkableObject);
      }
    }

    for (let ro of this.renderObjects) this.object.add(ro);
    this.object.dtacTile = this;
    for (let wo of this.walkableObjects) this.object.add(wo);

    this.links = [];
    this.setPosition(x, y, z);

    // this.position = new THREE.Vector3(x, y, z);
    this.id = XYZtoID(x, y, z);
  }

  setPosition(x, y, z) { this.object.position.set(x * TILE_X, y * TILE_Y, z * TILE_Z); }
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
  return (0xFF & x) | (0xFF & y) << 8 | (0xFF & z) << 16
}

function IDtoXYZ(id) {
  return [(0xFF & id), 0xFF & id >> 8, 0xFF & id >> 16]
}

function findReachableTiles(from, range) {
  if (range === undefined) throw "Undefined range";
  let reachables = [];
  let alreadyChecked = new Set();
  let toCheck = [[from, 0]];
  alreadyChecked.add(from);

  while(toCheck.length) {
    let [t, l] = toCheck.pop();

    let r = l + 1;
    if (r > range) continue;

    for (let n of t.links) {
      if (!n.isOccupied() && !alreadyChecked.has(n)) {
        alreadyChecked.add(n);
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

  while (queue.length) {
    let current = queue.dequeue();

    if (current === to) return _reconstructPath(cameFrom, current);
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

  return [];
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
  constructor(mapdef = makePlainMapDef(16, 16)) {
    this.grid = [];
    this.tiles = [];
    this.walkable = [];
    this.pickable = [];
    this.collidables = [];
    this.actors = [];
    let scene = this.scene = new THREE.Scene();
    this.mapdef = mapdef;
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

    let mydef = ActorDefs.Imp.resourcesFound ? ActorDefs.Imp : ActorDefs.Serpentipede;
    let mydef2 = ActorDefs.HellKnight.resourcesFound ? ActorDefs.HellKnight : ActorDefs.PainBringer;
    {
      let actor = new DTActor(mydef);
      actor.side = SIDE_PLAYER;
      actor.setTile(this.tileAt(3, 0, 3));
      this.addActor(actor);

      actor = new DTActor(mydef);
      actor.side = SIDE_PLAYER;
      actor.setTile(this.tileAt(4, 0, 7));
      this.addActor(actor);

      actor = new DTActor(ActorDefs.FreedoomGuy);
      actor.side = SIDE_PLAYER;
      actor.setTile(this.tileAt(8, 0, 2));
      this.addActor(actor);

      actor = new DTActor(ActorDefs.DoomGuy.resourcesFound ? ActorDefs.DoomGuy : ActorDefs.FreedoomGuy);
      actor.side = SIDE_PLAYER;
      actor.setTile(this.tileAt(10, 0, 2));
      this.addActor(actor);
    }

    let enemydef = ActorDefs.Serpentipede;
    {
      let actor2 = new DTActor(enemydef);
      actor2.setTile(this.tileAt(10, 0, 5));
      actor2.side = SIDE_AI;
      this.addActor(actor2);

      actor2 = new DTActor(enemydef);
      actor2.setTile(this.tileAt(11, 0, 3));
      actor2.side = SIDE_AI;
      this.addActor(actor2);

      actor2 = new DTActor(ActorDefs.PainBringer);
      actor2.setTile(this.tileAt(14, 0, 3));
      actor2.side = SIDE_AI;
      this.addActor(actor2);
    }

    this.bbox = new THREE.Box3();
    for (let tile of this.tiles) {
      this.bbox.expandByObject(tile.object);
    }
    this.bbox.expandByPoint(new THREE.Vector3(0, 20, 0));
  }

  initMap() {
    for (let z = 0; z < this.mapdef.height; z++) {
      for (let x = 0; x < this.mapdef.width; x++) {
        let tiledef = this.mapdef.tiles[XYZtoID(x, 0, z)];
        this.setTileFromDef(x, 0, z, tiledef);
      }
    }

    let g = this.grid;
    for (let z = 0; z < this.mapdef.height; z++) {
      for (let x = 0; x < this.mapdef.width; x++) {
        this.createTileLinks(x, 0, z);
      }
    }
  }

  createTileLinks(x, y, z) {
    let g = this.grid;
    let t = g[XYZtoID(x, y, z)], o;
    if (!t.walkable) return;
    for (let yd = -1; yd <= 1; yd++) {
      if ((o = g[XYZtoID(x - 1, y + yd, z)]) && !t.blocks(WEST) && !o.blocks(EAST)) t.addTwoWayLink(o);
      if ((o = g[XYZtoID(x + 1, y + yd, z)]) && !t.blocks(EAST) && !o.blocks(WEST)) t.addTwoWayLink(o);
      if ((o = g[XYZtoID(x, y + yd, z - 1)]) && !t.blocks(NORTH) && !o.blocks(SOUTH)) t.addTwoWayLink(o);
      if ((o = g[XYZtoID(x, y + yd, z + 1)]) && !t.blocks(SOUTH) && !o.blocks(NORTH)) t.addTwoWayLink(o);
    }
  }

  setTileFromDef(x, y, z, tiledef) {
    let old = this.grid[XYZtoID(x, y, z)];
    if (old) {
      old.removeAllLinks();
      swapRemove(this.tiles, old);
      for (let ro of old.renderObjects) swapRemove(this.collidables, ro);
      for (let wo of old.walkableObjects) {
        swapRemove(this.walkable, wo);
        swapRemove(this.pickable, wo);
      }
      this.scene.remove(old.object);
    }

    let t = new DTTile(tiledef, x, y, z);
    this.tiles.push(t);
    for (let ro of t.renderObjects) this.collidables.push(ro)
    for (let wo of t.walkableObjects) {
      this.walkable.push(wo);
      this.pickable.push(wo);
    }
    this.scene.add(t.object);
    this.grid[XYZtoID(x, y, z)] = t;

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
    this.pickable.push(actor.renderObject);
  }

  removeActor(actor) {
    this.scene.remove(actor.object);
    // this.actors.delete(actor);
    swapRemove(this.actors, actor);
    if (actor.collisionObject) {
      swapRemove(this.collidables, actor.collisionObject);
      swapRemove(this.pickable, actor.collisionObject);
    }
    swapRemove(this.pickable, actor.renderObject);
  }

  tileAt(x, y, z) {
    if (y === undefined) var {x, y, z} = x;
    return this.grid[XYZtoID(x, y, z)];
  }
}

const ACTOR_EYES = 0.75;
const ACTOR_OFFSET = 0.0;
const ActorCollisionGeom = new THREE.CylinderGeometry(0.4, 0.4, 1, 8, 1);
{ ActorCollisionGeom.translate(0, 0.5, 0); }
const ActorCollisionMaterial = new THREE.MeshBasicMaterial({color: 0xff00ff, wireframe: true, visible: true});
class DTActor {
  constructor(actordef) {
    this._dead = false;
    this.acted = false;
    this.actordef = actordef;

    let geometry = new THREE.PlaneGeometry( 1, 1, 1 );
    geometry.translate(0, 0.5, 0);

    let material = new THREE.MeshLambertMaterial( {color: 0xffffff, side: THREE.DoubleSide, transparent: true} );
    material.map = null;

    this.renderObject = new THREE.Mesh( geometry, material );
    this.renderObject.dtacActor = this;
    this.renderObject.castShadow = true;

    // this.collisionObject = this.renderObject; // FIXME: make this a cylinder

    if (!actordef.isProjectile) {
      this.collisionObject = new THREE.Mesh(ActorCollisionGeom, ActorCollisionMaterial);
      this.collisionObject.dtacActor = this;
    }

    this.facing = 0;
    let facingDir = new THREE.Vector3( 0, 0, 1 );
    let facingArrow = new THREE.ArrowHelper(facingDir, new THREE.Vector3(0, 0, 0), 0.5);

    this.object = new THREE.Group();
    this.object.dtacActor = this;
    this.object.add(this.renderObject);
    if (this.collisionObject) this.object.add(this.collisionObject);
    this.object.add(facingArrow);
    this.object.translateY(ACTOR_OFFSET);

    this.playAnim("idleAnim");

    this.hp = 2;
    this.side = SIDE_AI;

    let uniforms = { texture:  { type: "t", value: 0, texture: null } };
    let vertexShader = document.getElementById( 'vertexShaderDepth' ).textContent;
    let fragmentShader = document.getElementById( 'fragmentShaderDepth' ).textContent;
    this.renderObject.customDepthMaterial = new THREE.ShaderMaterial( { uniforms: uniforms, vertexShader: vertexShader, fragmentShader: fragmentShader } );

    this.renderObject.onBeforeRender = (r, s, cam) => {
      let v = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.Math.degToRad(-this.facing));
      facingArrow.setDirection(v);
    }
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
      let playingDeath = this.anim && (this.anim.name == "deathAnim" || this.anim.name == "deathAnimX");
      if (!playingDeath) {
        g_World.removeActor(this);
      }
    }

    let cam = g_MainCamera;
    let cp = cam.position.clone();
    cp.y *= 0.2;
    this.renderObject.lookAt(cp);

    cp.sub(this.object.position)
    cp.y = 0;
    cp.normalize();
    let rads = new THREE.Vector2(cp.z, cp.x).angle();
    let degs = THREE.Math.radToDeg(rads);
    degs += 22.5 + this.facing;
    let dir = (((degs / 45)|0) % 8);

    let fr = this.anim.frame.bydir[dir];
    if (!fr) fr = this.anim.frame.bydir[0];
    let ro = this.renderObject;
    if(ro.material.map != fr.texture) {
      ro.material.map = fr.texture;
      ro.material.needsUpdate = true;

      let utx = ro.customDepthMaterial.uniforms.texture;
      utx.value = fr.texture;
      ro.customDepthMaterial.needsUpdate = true;

      let xx = fr.graphic.width / 50;
      let yy = fr.graphic.height / 50;
      ro.scale.set(xx, yy, 1)
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
    if (tile && tile.actor) throw "Something already stands on that tile";
    if (this.tile) this.tile.actor = null;
    this.tile = tile;
    if(this.tile) this.tile.actor = this;

    if (this.tile && warpTo) {
      const {x, y, z} = tile.position;
      this.setPosition(x, y, z);
    }
  }

  setPosition(x, y, z) {
    if (y === undefined) this.object.position.copy(x);
    else this.object.position.set(x, y, z);
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

  hurt(damage, source) {
    console.warn("hurt unimplemented")
    this.hp -= 1;
    if (this.hp <= 0) this.die();
    else if (this.hasAnim("painAnim")) {
      this.playAnim("painAnim");
    }
    // if (this.hasAnim("deathAnim")) {
    //   this.playAnim("deathAnim");
    // }
  }

  isAlive() {
    return this._dead !== true;
  }

  die() {
    this._dead = true;
    this.setTile(null);
    if (this.hasAnim("deathAnim")) {
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
      result += randomBetween(1, this.sides+1)
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
    return randomBetween(this.from, this.to + 1) + this.bonus
  }
}

const Weapons = {
  Shotgun: {
    name: "Shotgun",
    projectile: "GenericBullet",
    horizontalSpread: 12,
    verticalSpread: 3,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 5,
    shots: 1,
  },
  Minigun: {
    name: "Minigun",
    projectile: "GenericBullet",
    horizontalSpread: 8,
    verticalSpread: 8,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 8,
  },
  Rifle: {
    name: "Rifle",
    projectile: "GenericBullet",
    horizontalSpread: 5,
    verticalSpread: 5,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 1,
  },
  ImpBall: {
    name: "Imp Ball",
    projectile: "ImpBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 1,
  },
  SerpentipedeBall: {
    name: "Serpentipede Ball",
    projectile: "SerpentipedeBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 1,
  },
  HellKnightBall: {
    name: "Hell Knight Ball",
    projectile: "HellKnightBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 1,
  },
  PainBringerBall: {
    name: "Pain Bringer Ball",
    projectile: "PainBringerBall",
    horizontalSpread: 7,
    verticalSpread: 3,
    damage: new UniformRoll(3, 5),
    bulletsPerShot: 1,
    shots: 1,
  },
  PinkyBite: {
    name: "Bite",
    projectile: null,
    isMelee: true,
    damage: new UniformRoll(3, 5),
  }
}

const ActorDefs = {
  FreedoomGuy: {
    name: "Freedoom Guy",
    from: ["freedoom2.wad"],
    speed: 15,
    rawAnims: PlayerRaws,
    weapons: [
      Weapons.Minigun
    ]
  },

  DoomGuy: {
    name: "Doom Guy",
    from: ["doom.wad", "doom2.wad"],
    speed: 15,
    rawAnims: PlayerRaws,
    weapons: [
      Weapons.Shotgun
    ]
  },

  Serpentipede: {
    name: "Serpentipede",
    from: ["freedoom2.wad"],
    speed: 15,
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
    speed: 15,
    rawAnims: ImpSerpRaws,
    weapons: [
      Weapons.ImpBall
    ],
  },

  ImpBall: {
    name: "Imp Ball",
    from: ["doom.wad", "doom2.wad"],
    speed: 9,
    isProjectile: true,
    rawAnims: ImpSerpBallRaws
  },

  HellKnight: {
    name: "Hell Knight",
    from: ["doom2.wad"],
    speed: 15,
    weapons: [
      Weapons.HellKnightBall
    ],
    rawAnims: HKPBRaws,
  },

  HellKnightBall: {
    name: "Hell Knight Ball",
    from: ["doom2.wad"],
    speed: 8,
    isProjectile: true,
    rawAnims: HKPBBallRaws,
  },

  PainBringer: {
    name: "Pain Bringer",
    from: ["freedoom2.wad"],
    speed: 15,
    weapons: [
      Weapons.PainBringerBall
    ],
    rawAnims: HKPBRaws,
  },

  PainBringerBall: {
    name: "Pain Bringer Ball",
    from: ["freedoom2.wad"],
    speed: 8,
    isProjectile: true,
    rawAnims: HKPBBallRaws,
  },

  GenericBullet: {
    name: "Bullet",
    from: ["freedoom2.wad"],
    speed: 24,
    isProjectile: true,
    rawAnims: HKPBBallRaws
  }
}

function prepareActorDefs() {
  for (let adefname in ActorDefs) {
    let adef = ActorDefs[adefname];
    let rawAnims = adef.rawAnims;
    if (adef.parsedAnims) continue; // already parsed

    let wadres;
    for (let wadname of adef.from) {
      if (wadres = Resources.wads[wadname]) break;
    }
    if (!wadres) {
      console.warn("No resource WAD for actor " + adefname)
      adef.resourcesFound = false;
      continue;
    }

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
}

const ZombieMan = {
  name: "Former Human",
  graphicName: "POSS",
  radius: 20,
  health: 40,
  speed: 8,
  from: ["doom", "doom2"],
  walkAnim: [["POSS", "AABBCCDD", 4, "travel"]],
  shootAnim: [
    ["POSS", "E", 8, LightUp],
    ["POSS", "F", 8, LightUp, "fire"],
    ["POSS", "E", 8, LightUp,]
  ],
  baseRangedAttack: (self) => rangedAttack(self, self.target, {
    horizontalSpread: 22.5,
    verticalSpread: 0,
    numBullets: 1,
    damagePerBullet: () => (Math.random() * 4 + 1) * 3,
    puff: "BulletPuff",
  })
}

var g_Raycaster = new THREE.Raycaster();
var g_MousePosition = new THREE.Vector2();

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

  window.addEventListener( 'keyup', function (event) {
    g_KeysPressed.push(event.which);
  });

  window.addEventListener( 'keyup', function (event) {
    g_KeysReleased.push(event.which);
    if (event.which == Keys.E) {
      toggleMode();
    } else if (g_Mode == EDIT_MODE) {
      if (event.which == Keys.A) {
        g_EditModeGrid.position.y += 0.25;
      } else if (event.which == Keys.Z) {
        g_EditModeGrid.position.y -= 0.25;
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

const SIDE_PLAYER = 0, SIDE_AI = 1;
let g_CurrentSide = SIDE_PLAYER;

let ui_CTHLabel = document.getElementById("CTHLabel");

class CTHEstimate {
  constructor() {
    this.reset();
  }

  reset() {
    this.checks = 0;
    this.hits = 0;
    this.friendlyHits = 0;
    this.actor = null;
  }

  getCTH() { return this.hits / this.checks; }
  getFriendlyCTH() { return this.friendlyHits / this.checks; }

  update(attacker, victim, attackDef, samples=25) {
    let raycaster = CTHEstimate._raycaster;
    let intersected = CTHEstimate._intersected;
    intersected.length = 0;

    let pos = new THREE.Vector3(), dir = new THREE.Vector3();
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

function resetCTH(cth, resetLabel=true) {
  cth.reset();
  if (resetLabel) ui_CTHLabel.innerText = "";
}

function updateCTH(cth, attacker, victim, attackDef, updateLabel=true) {
  cth.update(attacker, victim, attackDef)
  if (updateLabel) ui_CTHLabel.innerText = "CTH ≈ " + Math.round(cth.getCTH() * 100) + "% (" + Math.round(cth.getFriendlyCTH() * 100) + "% friendly)";
}

function aiAct() {
  let ai = g_World.actors.find(a => a.side == SIDE_AI && !a.acted && a.isAlive());
  if (!ai) return;
  ai.acted = true;
  let atkDef = ai.actordef.weapons[0];
  let tgt = g_World.actors.find(a => {
    if (a.side != SIDE_AI && a.isAlive()) {
      let cth = new CTHEstimate();
      cth.update(ai, a, atkDef, 300)
      if (cth.getCTH() >= 0.1 && cth.getFriendlyCTH() < 0.25) {
        return true;
      }
    }
    return false;
  });

  if (tgt) {
    g_TrackedActor = ai;
    g_CurrentAction = doAttack(ai, tgt, atkDef);
  } else {
    let reachables = findReachableTiles(ai.tile, 5);
    let t = choose(reachables).tile;
    g_TrackedActor = ai;
    g_CurrentAction = doTravel(ai, findPath(ai.tile, t));
  }
}

function playerSelectActor(actor) {
  g_SelectedActor = actor;
  g_TrackedActor = actor;
  g_MainCameraLerping = true;
  g_SelectedActorReachables = null;
}

let oldReachables = [];
function playerAct() {
  if (!g_SelectedActor || g_SelectedActor.acted || !g_SelectedActor.isAlive()) {
    playerSelectActor(g_World.actors.find(
      a => a.side == SIDE_PLAYER && !a.acted && a.isAlive()));
  }

  if (!g_SelectedActor) return;
  g_TrackedActor = g_SelectedActor;

  let reachables = findReachableTiles(g_SelectedActor.tile, 3);
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
      let p = findPath(g_SelectedActor.tile, obj.dtacTile);
      // for (let t of p) {
      //   let obj = t.walkableObject;
      //   let oldMat = obj.material;
      //   obj.material = walkableObjectMaterial;
      //   oldIntersects.push([obj, oldMat]);
      // }

      if (g_PlayerClicked && p[p.length-1] == obj.dtacTile) {
        p.shift();
        let a = obj.dtacTile.actor;
        if (a && a.isAlive() && a !== g_SelectedActor) {
          let atkDef = g_SelectedActor.actordef.weapons[0];
          g_CurrentAction = doAttack(g_SelectedActor, a, atkDef);
        } else {
          g_CurrentAction = doTravel(g_SelectedActor, p);
        }
        g_SelectedActor.acted = true;
      }
      return;
    } else if (obj.dtacActor && obj.dtacActor.isAlive()) {
      let a = obj.dtacActor;
      if (a.side == SIDE_PLAYER) {
        showHoverCursorAt(a.position, 0x00ff00);
        if (g_PlayerClicked) playerSelectActor(a);
      } else if (a.isAlive()) {
        showHoverCursorAt(a.position, 0xff0000);
        if (g_PlayerClicked) {
          let atkDef = g_SelectedActor.actordef.weapons[0];
          g_CurrentAction = doAttack(g_SelectedActor, a, atkDef);
          g_SelectedActor.acted = true;
        } else {
          if (a !== g_CTHEstimator.actor) {
            resetCTH(g_CTHEstimator);
            g_CTHEstimator.actor = a;
          }
          let atkDef = g_SelectedActor.actordef.weapons[0];
          updateCTH(g_CTHEstimator, g_SelectedActor, a, atkDef);
        }
      }
      return;
    }
  }
}

let g_ActorHoverCursor = (() => {
  let box = new THREE.BoxGeometry(1, 1.5, 1);
  box.translate(0, 0.75, 0);
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
  if (colorHex !== undefined) g_ActorHoverCursor.material.color.set(colorHex);
}

let g_SelectedActor;
let g_TrackedActor;
let g_MainCameraLerping = false;
let g_TurnCount = 0;

const PLAY_MODE = 0, EDIT_MODE = 1;
let g_Mode = PLAY_MODE;

let g_EditModeGrid = new THREE.Group();
let g_EditModeGridHelper = new THREE.GridHelper(32, 32, 0xff0000, 0xffff00);
let g_EditModeGridPlane = new THREE.Mesh((new THREE.PlaneGeometry(32, 32)).rotateX(THREE.Math.degToRad(-90)));
{
  g_EditModeGrid.add(g_EditModeGridHelper);
  g_EditModeGrid.add(g_EditModeGridPlane);
  g_EditModeGridPlane.material.visible = false;
  g_EditModeGridHelper.position.y += 0.0125;
  g_EditModeGrid.position.x -= 0.5 - 16;
  g_EditModeGrid.position.z -= 0.5 - 16;
}

function toggleMode() {
  removePreviewTile();
  if (g_Mode == EDIT_MODE) {
    g_Mode = PLAY_MODE;
    g_World.scene.remove(g_EditModeGrid);
  } else if (g_Mode == PLAY_MODE) {
    resetPreviewTile();
    g_World.scene.add(g_EditModeGrid);
    g_Mode = EDIT_MODE;
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
    for (let def in TileModelDefs) { g_EditModeSelectedDef = def; break; }
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
  resetPreviewTile();
}

function editMode(dt) {
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

    if (justPressedKey(Keys.R)) {
      g_EditModeRot += 1;
      g_EditModeRot %= MAX_ROT+1;
      resetPreviewTile();
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
      addPart(td.parts, {def: g_EditModeSelectedDef, rotationY: g_EditModeRot});
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

function playMode(dt) {
  if (g_CurrentAction) {
    resetCTH(g_CTHEstimator);
    let r = g_CurrentAction.next(dt);
    if (r.done) g_CurrentAction = null;
  } else {
    let allActed = true;
    for (let a of g_World.actors) {
      if (!a.isProjectile && a.side == g_CurrentSide && a.isAlive() && !a.acted) {
        allActed = false;
        break;
      }
    }

    if (allActed) {
      g_TurnCount += 1;
      g_CurrentSide = g_CurrentSide === SIDE_PLAYER ? SIDE_AI : SIDE_PLAYER;

      for (let a of g_World.actors) {
        a.acted = false;
      }
    }

    if (g_CurrentSide == SIDE_AI) {
      aiAct();
    } else {
      playerAct();
    }
  }

  if (g_MainCameraLerping || g_CurrentAction) {
    g_MainCameraLerping = true;

    const PAN = 8, ROTATE = 3;
    const camState = g_MainCameraControls.getState();

    if (this.initOffset === undefined || g_MainCameraControlsZoomChanged || camState & ROTATE) {
      this.initOffset = g_MainCamera.position.clone().sub(g_MainCameraControls.target)
    };

    //let p = g_SelectedActor && g_SelectedActor.isAlive() ? g_SelectedActor.object.position.clone() : new THREE.Vector3();
    let a = g_TrackedActor || g_SelectedActor;
    let p = a ? a.object.position.clone() : new THREE.Vector3();
    if (a && a.actordef.isProjectile) p.y -= 0.5;
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

function mainLoop(currentTime) {
  let dt = (this.lastCurrentTime ? currentTime - this.lastCurrentTime : 0) / 1000.0;
  this.lastCurrentTime = currentTime;
  requestAnimationFrame( mainLoop );

  for (let [obj, oldMat] of oldReachables) {
    obj.material = oldMat;
  }
  oldReachables.length = 0;
  hideHoverCursor();

  if (g_Mode == PLAY_MODE) {
    playMode(dt);
  } else if (g_Mode == EDIT_MODE) {
    editMode(dt);
  }
  g_PlayerClicked = false;

  g_MainCameraControlsZoomChanged = false;
  g_MainCameraControls.update();

  g_Renderer.render( g_World.scene, g_MainCamera );

  g_KeysPressed.length = 0;
  g.g_KeysReleased.length = 0;
}

function nextPowerOf2(x) {
  return Math.pow(2,Math.floor(Math.log(x)/Math.log(2)))
}

function isPowerOfTwo(x)
{
    return (x & (x - 1)) == 0;
}

/*
// var wad = Object.create(Wad); // Create a new WAD object to load our file into

// // Create a callback function when loading is complete
// wad.onLoad = function() {
//   setTimeout(start, 1)
// };

// wad.onProgress = function(x) {
//   //console.log("Progress!");
// }

// wad.loadURL('freedoom2.wad');

var frame = 0;
var canvas = null;
var renderer, scene, camera, cube, controls;
var cubeMaterial;
var cubeMaterials = [];
var dude, dudeMat;
var cylinder;

function setupScene() {
  scene = new THREE.Scene();

  renderer = new THREE.WebGLRenderer();
  renderer.setSize( window.innerWidth * 1.0, window.innerHeight * 1.0);
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap; // default THREE.PCFShadowMap

  document.body.appendChild( renderer.domElement );

  var geometry = new THREE.BoxGeometry( 1, 1, 1 );
  for (let flatname of ["FLOOR4_8", "FLOOR5_1", "FLOOR5_2", "FLOOR5_3"]) {
    let flat = Object.create(Flat);
    let flatLump = wad.getLumpByName(flatname);
    flat.load(flatLump);
    let c = flat.toCanvas(wad);
    let cubeMaterial = new THREE.MeshLambertMaterial( { color: 0xffffff } );
    let tx = new THREE.CanvasTexture(c);
    tx.anisotropy = renderer.getMaxAnisotropy();
    tx.magFilter = THREE.NearestFilter;
    tx.needsUpdate = true;
    cubeMaterial.map = tx;
    cubeMaterial.needsUpdate = true;
    cubeMaterials.push(cubeMaterial);
  }

  for (let x = -16; x < 16; x++) {
    for (let z = -16; z < 16; z++) {
      cube = new THREE.Mesh( geometry, choose(cubeMaterials) );
      cube.position.set(x, 0, z);
      cube.receiveShadow = true;
      scene.add( cube );
    }
  }

  var light = new THREE.PointLight( 0x0000ff, 1, 10 );
  // light.castShadow = true;
  light.position.set( -5, 5, 5 );
  scene.add( light );

  // White directional light at half intensity shining from the top.
  var ambientLight = new THREE.AmbientLight( 0xffffff, 0.1 );
  scene.add(ambientLight)
  var sun = new THREE.DirectionalLight( 0xffffff, 0.5 );
  sun.position.set(10, 10, 10);
  sun.castShadow = true;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(-1.5, -1, -1.2);

  {
    var uniforms = { texture:  { type: "t", value: 0, texture: null } };
    var vertexShader = document.getElementById( 'vertexShaderDepth' ).textContent;
    var fragmentShader = document.getElementById( 'fragmentShaderDepth' ).textContent;

    let geometry = new THREE.PlaneGeometry( 1, 1, 1 );
    geometry.translate(0, 0.5, 0);
    let material = dudeMat = new THREE.MeshLambertMaterial( {color: 0xffffff, side: THREE.DoubleSide, transparent: true} );
    dude = new THREE.Mesh( geometry, material );
    dude.castShadow = true;
    //dude.position.y += 1;

    dude.onBeforeRender = function(r, s, cam) {
      let cp = cam.position.clone();
      cp.y *= 0.33;
      dude.lookAt(cp);
    }

    dude.material.emissive.setRGB(0.1, 0, 0)

    dude.customDepthMaterial = new THREE.ShaderMaterial( { uniforms: uniforms, vertexShader: vertexShader, fragmentShader: fragmentShader } );

    let group = new THREE.Group();
    {
      // let geometry = new THREE.CircleGeometry( 0.5, 64 );
      let geometry = new THREE.RingGeometry( 0.25, 0.5, 32 );
      // let material = new THREE.MeshBasicMaterial( {color: 0xffff00} );
      // let cylinder = new THREE.Mesh( geometry, material );
      // cylinder.position.y += 1;
      let geo = new THREE.EdgesGeometry( geometry ); // or WireframeGeometry( geometry )
      let mat = new THREE.LineBasicMaterial( { color: 0xcc0000, linewidth: 5} );
      cylinder = new THREE.LineSegments( geo, mat );
      cylinder.lookAt(0, 1, 0);
      cylinder.position.y += 0.05;
      // cylinder.add( wireframe );
      group.add( cylinder );
    }
    group.add(dude);
    group.position.y += 0.5;
    scene.add(group);
  }


}


var sprname = 'TROO'
var states = 'AC'
var stateIdx = 0;
function nextFrame() {
  let graphic = Object.create(Graphic); // We create Graphic objects just like Wad object files

  if (frame % 10 == 0) stateIdx += 1
  let s = states[stateIdx % states.length];
  let f = 1 //(frame % 8 + 1);
  let cp = camera.position.clone().sub(dude.position);
  cp.y = 0;
  cp.normalize();
  let rads = new THREE.Vector2(cp.z, cp.x).angle();//new Math.atan2(cp.x, cp.z);
  let degs = THREE.Math.radToDeg(rads);
  degs += 22.5;
  //if (degs < 0) degs += 180;
  f = (((degs / 45)|0) % 8) + 1;
  let flip = false;
  let lump = wad.getLumpByName(sprname + s + f);
  if (!lump) {
    switch(f) {
    case 8: flip = true; case 2: lump = wad.getLumpByName(sprname + s + 2 + s + 8); break;
    case 7: flip = true; case 3: lump = wad.getLumpByName(sprname + s + 3 + s + 7); break;
    case 6: flip = true; case 4: lump = wad.getLumpByName(sprname + s + 4 + s + 6); break;
    }
  }
  graphic.load(lump); // Load the player sprite from DOOM2.WAD

  if (canvas) canvas.remove();
  canvas = graphic.toCanvas(wad); // Export the image to a HTML5 canvas
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

  // document.body.appendChild(canvas); // Place the image on the page
  frame += 1;

  let tx = new THREE.CanvasTexture(canvas);
  tx.magFilter = THREE.NearestFilter;
  tx.needsUpdate = true;
  dudeMat.map = tx;
  dude.customDepthMaterial.uniforms.texture.value = dude.customDepthMaterial.uniforms.texture.texture = tx;
  dude.customDepthMaterial.needsUpdate = true;
  dudeMat.needsUpdate = true;

  setTimeout(nextFrame, 1000/20);
}
*/