// var wad = Object.create(Wad); // Create a new WAD object to load our file into

// // Create a callback function when loading is complete
// wad.onLoad = function() {
//   setTimeout(start, 1)
// };

// wad.onProgress = function(x) {
//   //console.log("Progress!");
// }

// wad.loadURL('freedoom2.wad');
const PriorityQueue = require("js-priority-queue");

function choose(x) {
  let y = x;
  if (arguments.length > 1) y = arguments;
  return y[(Math.random() * y.length) | 0]
}

var frame = 0;
var canvas = null;
var renderer, scene, camera, cube, controls;
var cubeMaterial;
var cubeMaterials = [];
var dude, dudeMat;
var cylinder;

const BASE_WAD = "doom.wad";
let g_Renderer;
let g_World;
let g_MainCamera;
let g_MainCameraControls;
let g_TestActor;
let g_CurrentAction;

const Resources = {
  wads: [],

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
        setTimeout(function() {
          resolve(that.wads[as] = new DTWadResource(wadLocal));
        }, 1)
      }
      wadLocal.loadURL(url)
    });
  }
}

function start() {
  Resources.loadWadFromURL(BASE_WAD).then(
    function() {
      let renderer = g_Renderer = new THREE.WebGLRenderer();
      renderer.setSize( window.innerWidth * 1.0, window.innerHeight * 1.0);
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap; // default THREE.PCFShadowMap
      document.body.appendChild( renderer.domElement );

      g_World = new DTWorld();
      g_MainCamera = new THREE.PerspectiveCamera( 40, window.innerWidth / window.innerHeight, 0.1, 1000 );
      g_MainCamera.position.z = 5;
      g_MainCamera.position.y = 2;
      g_MainCameraControls = new THREE.MapControls( g_MainCamera );
      //setupScene();
      mainLoop();

      // setTimeout(nextFrame, 1);
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
    this.flats = [];
    this.sprites = [];
  }

  getFlat(name) {
    let f = this.flats[name];
    if (!f) {
      f = this.flats[name] = new DTDoomFlat(this, name);
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

class DTDoomSpriteAnim {
  constructor(wadres, animdef) {
    let i = 0;
    let parsed = this.parsed = [];
    for (let part of animdef) {
      let base = part[i++];
      let frames = part[i++];
      let time = part[i++];
      let animEvent = part[i++];

      for (let frame of frames) {
        parsed.push({
          frame: wadres.getSprite(base, frame),
          time: time,
          animEvent: animEvent,
        });
      }
    }

    this.dtAccum = 0;
    this.currentFrameNumber = 0;
  }

  start() {
    this.changeToFrame(0);
  }

  changeToFrame(frameNumber) {
    this.currentFrameNumber = frameNumber;
    let {frame, time, animEvent} = this.parsed[this.currentFrameNumber];
    this.frame = frame;
    this.ticsToGo = time;
    if (animEvent && this.onAnimEvent) {
      this.onAnimEvent(animEvent);
    }
  }

  advance(dt) {
    const TIC = 1.0/35.0;
    this.dtAccum += dt;
    while(this.dtAccum >= TIC) {
      this.dtAccum -= TIC;
      this.ticsToGo -= 1;
      if (this.ticsToGo == 0) {
        this.changeToFrame((this.currentFrameNumber + 1) % this.parsed.length);
      }
    }
  }
}

class DTDoomFlat {
  constructor(wadres, flatname) {
    let wad = wadres.wadjs;
    let flat = Object.create(Flat);
    let flatLump = wad.getLumpByName(flatname);
    flat.load(flatLump);
    let c = flat.toCanvas(wad);
    let tx = new THREE.CanvasTexture(c);
    tx.anisotropy = g_Renderer.getMaxAnisotropy();
    tx.magFilter = THREE.NearestFilter;
    tx.needsUpdate = true;
    this.texture = tx;
  }
}

class DTTileModel {
  constructor(geom, material, walkableGeom) {
    this.geom = geom;
    this.material = material;
    this.walkableGeom = walkableGeom;
  }
}

function moveTowards0(from, to, step) {
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

function* combined(...gens) {
  while(gens.length != 0) {
    let dt = yield;
    let newgens = [];
    for (let g of gens) {
      let r = g.next(dt);
      if (!r.done) newgens.push(g);
    }
    gens = newgens;
  }
}

function* moveTowards(from, to, step_) {
  while(!from.equals(to)) {
    let tmp = to.clone();
    let dt = yield;
    let step = step_ * dt;
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

function* faceTowards(actor, position, step_) {
  let cp = position.clone();
  cp.sub(actor.object.position) // .subVectors(cam.position, cp);
  cp.y = 0;
  cp.normalize();
  let rads = new THREE.Vector2(cp.z, -cp.x).angle();//new Math.atan2(cp.x, cp.z);
  let degs = THREE.Math.radToDeg(rads);
  console.log("degs: " + degs);
  let needToRotate = degs - actor.facing;
  console.log("needToRotate1: " + needToRotate);
  if (needToRotate > 180) needToRotate = needToRotate - 360;
  if (needToRotate < -180) needToRotate = needToRotate + 360;
  let stepSign = 1;
  if (needToRotate < 0) {
    stepSign = -1;
    needToRotate = -needToRotate;
  }
  console.log("needToRotate2: " + needToRotate);
  let amountRotated = 0;
  while(actor.facing != degs) {
    let dt = yield;
    let step = step_ * dt;
    if (Math.abs(amountRotated - needToRotate) < step) {
      actor.facing = degs;
      amountRotated = needToRotate;
    } else {
      actor.facing += step * stepSign;
      amountRotated += step;
    }
  }
}

function* doTravel(actor, path) {
  actor.setAnim(actor.actordef.preparedAnims.walkAnim);
  for (let tile of path) {
    let tpos = tile.position.clone();
    tpos.y += 0.5;
    yield* combined(
      faceTowards(actor, tpos, 360),
      moveTowards(actor.object.position, tpos, 4)
    );
    actor.setTile(tile);
  }
  actor.setAnim(actor.actordef.preparedAnims.idleAnim);
}

class TravelAction {
  constructor(actor, path) {
    actor.setAnim(actor.actordef.preparedAnims.walkAnim);
  }
}

const walkableObjectMaterialTest = new THREE.MeshLambertMaterial({color: 0x00ffff, transparent: true, opacity: 0.25})
const walkableObjectMaterial = new THREE.MeshLambertMaterial({color: 0xffff00, transparent: true, opacity: 0.25})
const walkableObjectMaterialInvisible = new THREE.MeshLambertMaterial({color: 0x00ffff, visible: false})
class DTTile {
  constructor(model, x, y, z) {
    this.renderObject = new THREE.Mesh(model.geom, model.material)
    this.renderObject.dtacTile = this;
    if (model.walkableGeom) {
      this.walkableObject = new THREE.Mesh(model.walkableGeom, walkableObjectMaterialInvisible);
      this.walkableObject.dtacTile = this;
    }
    this.object = new THREE.Group();
    this.object.add(this.renderObject);
    this.object.dtacTile = this;
    if (this.walkableObject) this.object.add(this.walkableObject);

    this.links = [];

    this.object.position.set(x, y, z);
    this.position = new THREE.Vector3(x, y, z);
    this.id = XYZtoID(x, 0, z);
  }

  addTwoWayLink(other) {
    if (this.links.indexOf(other) == -1) this.links.push(other);
    if (other.links.indexOf(this) == -1) other.links.push(this);
  }

  distanceTo(other) {
    return this.position.distanceTo(other.position);
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
  //let queue = [from];

  while (queue.length) {
    let current = queue.dequeue();

    // let current = queue[0];
    // let j = 0;
    // for (let i = 1; i < queue.length; i++) {
    //   if (getF(queue[i]) < getF(current)) {
    //     j = i;
    //     current = queue[i]
    //   };
    // }
    // queue.splice(j, 1)

    if (current === to) return _reconstructPath(cameFrom, current);
    closedSet.add(current);

    for (let link of current.links) {
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

class DTWorld {
  constructor() {
    this.grid = [];
    this.tiles = [];
    this.walkable = [];
    let scene = this.scene = new THREE.Scene();

    let qweqeq = {
      id: [1, 0, 1],
      walkable: true,
      links: [[2, 0, 1]],
      model: "Box"
    }

    let plane = new THREE.PlaneGeometry();
    plane.rotateX(THREE.Math.degToRad(-90));
    plane.translate(0, 0.51, 0);
    let basic = new DTTileModel(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({map: Resources.wads[BASE_WAD].getFlat("FLOOR4_8").texture}),
      plane,
    )

    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let t = new DTTile(basic, x, 0, z);
        this.tiles.push(t);
        if (t.walkableObject) this.walkable.push(t.walkableObject);
        this.scene.add(t.object);
        this.grid[XYZtoID(x, 0, z)] = t;

        if (false && s((z % 4) ^ (x % 4)) == 1) {
          let actor = new DTActor();
          this.scene.add(actor.object);
          actor.setPosition(x, 0.5, z);
        }
      }
    }

    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let g = this.grid;
        let t = g[XYZtoID(x, 0, z)], o;
        // if (o = g[XYZtoID(x - 1, 0, z)]) t.addTwoWayLink(o);
        // if (o = g[XYZtoID(x + 1, 0, z)]) t.addTwoWayLink(o);
        // if (o = g[XYZtoID(x, 0, z - 1)]) t.addTwoWayLink(o);
        // if (o = g[XYZtoID(x, 0, z + 1)]) t.addTwoWayLink(o);
        for (let zd = -1; zd <= 1; zd++) {
          for (let xd = -1; xd <= 1; xd++) {
            if ((o = g[XYZtoID(x + xd, 0, z + zd)]) && o !== t) t.addTwoWayLink(o);
          }
        }
      }
    }

    let ambientLight = new THREE.AmbientLight( 0xffffff, 0.5 );
    scene.add(ambientLight)
    let sun = new THREE.DirectionalLight( 0xffffff, 0.2 );
    sun.position.set(0, 0, 0);
    sun.castShadow = true;
    scene.add(sun);
    scene.add(sun.target);
    sun.target.position.set(-1, -1.5, -2.34);

    let actor = g_TestActor = new DTActor();
    this.scene.add(actor.object);
    actor.setTile(this.tileAt(3, 0, 3));
  }

  tileAt(x, y, z) {
    if (y === undefined) var {x, y, z} = x;
    return this.grid[XYZtoID(x, y, z)];
  }
}

class DTActor {
  constructor() {
    let geometry = new THREE.PlaneGeometry( 1, 1, 1 );
    geometry.translate(0, 0.5, 0);

    let material = new THREE.MeshLambertMaterial( {color: 0xffffff, side: THREE.DoubleSide, transparent: true} );
    let spr = Resources.wads[BASE_WAD].getSprite(choose('TROO', 'POSS', 'SARG', 'BOSS'), 'A')

    material.map = null // spr.bydir[0].texture

    this.renderObject = new THREE.Mesh( geometry, material );
    this.renderObject.castShadow = true;

    this.facing = 0;
    let facingDir = new THREE.Vector3( 0, 0, 1 );
    let facingArrow = new THREE.ArrowHelper(facingDir, new THREE.Vector3(0, 0.5, 0), 0.5);

    this.object = new THREE.Group();
    this.object.add(this.renderObject);
    this.object.add(facingArrow);
    this.object.translateY(0.5);

    // let anim = this.anim = new DTDoomSpriteAnim(spr.wadres, Serpentipede.idleAnim);
    // anim.start();

    this.actordef = {
      preparedAnims: {
        walkAnim: new DTDoomSpriteAnim(spr.wadres, Serpentipede.walkAnim),
        idleAnim: new DTDoomSpriteAnim(spr.wadres, Serpentipede.idleAnim),
      }
    }

    this.anim = this.actordef.preparedAnims.walkAnim;
    this.anim.start();

    let lastTime;
    this.renderObject.onBeforeRender = (r, s, cam) => {
      if (lastTime === undefined) lastTime = performance.now();
      let thisTime = performance.now();
      let dt = (thisTime  - lastTime) / 1000.0;
      lastTime = thisTime;
      this.anim.advance(dt);

      // facing += 0.25;
      let facing = this.facing;
      facingArrow.setDirection(new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.Math.degToRad(-facing)))

      let cp = cam.position.clone();
      cp.y *= 0.33;
      this.renderObject.lookAt(cp);

      cp.sub(this.object.position) // .subVectors(cam.position, cp);
      cp.y = 0;
      cp.normalize();
      let rads = new THREE.Vector2(cp.z, cp.x).angle();//new Math.atan2(cp.x, cp.z);
      let degs = THREE.Math.radToDeg(rads);
      degs += 22.5 + facing;
      let dir = ((degs / 45)|0) % 8;

      let fr = this.anim.frame.bydir[dir];
      if (!fr) fr = this.anim.frame.bydir[0];
      material.map = fr.texture;

      let xx = fr.graphic.width / 50;
      let yy = fr.graphic.height / 50;
      this.renderObject.scale.set(xx, yy, 1)
    }
  }

  setAnim(anim, start = true) {
    this.anim = anim;
    if (start && this.anim) this.anim.start();
  }

  setTile(tile, warpTo = true) {
    if (this.tile) this.tile.actor = null;
    this.tile = tile;
    this.tile.actor = this;

    if (warpTo) {
      const {x, y, z} = tile.position;
      this.setPosition(x, y + 0.5, z);
    }
  }

  setPosition(x, y, z) {
    if (y === undefined) this.object.position.copy(x);
    else this.object.position.set(x, y, z);
  }
}

const LightUp = {}

const Serpentipede = {
  name: "Serpentipede",
  graphicName: "TROO",
  from: ["freedoom2"],
  idleAnim: [
    ["TROO", "AB", 15]
  ],
  walkAnim: [
    ["TROO", "ABCD", 7, "travel"]
  ],

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

class DTZombieMan {
  constructor() {
    this.mesh = new THREE.Mesh();
  }
}

var g_Raycaster = new THREE.Raycaster();
var g_MousePosition = new THREE.Vector2();

let g_DoMove = false;
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
    if (event.button == 0 && mx == event.screenX && my == event.screenY) {
      g_DoMove = true;
    }
  }, false );
}

function loadSpriteFromWad(wad, sprite, frame) {
  let sprname = sprite;
  let s = frame;

  let results = [];

  for (let f = 1; f <= 8; f++) {
    let graphic = Object.create(Graphic);

    let flip = false;
    let lump = wad.getLumpByName(sprname + s + f);
    if (!lump) {
      switch(f) {
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

let oldIntersects = [];
function mainLoop(currentTime) {
  let dt = (this.lastCurrentTime ? currentTime - this.lastCurrentTime : 0) / 1000.0;
  this.lastCurrentTime = currentTime;
  requestAnimationFrame( mainLoop );
  // cube.rotation.z += 0.01;
  // cube.rotation.y += 0.01;
  // let cp = camera.position.clone();
  // cp.y *= 0.33;
  // dude.lookAt(cp);


  // update the picking ray with the camera and mouse position
  // let s = 1 + Math.sin(performance.now() * 0.001) * 0.02;
  // dude.scale.set(s, s, s)
  // cylinder.scale.set(s, s, s)

	g_Raycaster.setFromCamera( g_MousePosition, g_MainCamera );

  for (let [obj, oldMat] of oldIntersects) {
    obj.material = oldMat;
  }

  if (g_CurrentAction) {
    let r = g_CurrentAction.next(dt);
    if (r.done) g_CurrentAction = null;
  } else {
    oldIntersects = [];
    // calculate objects intersecting the picking ray
    let intersects = g_Raycaster.intersectObjects( g_World.walkable );
    for ( let i = 0;
          i < intersects.length && 1;
          i++ ) {

      let obj = intersects[ i ].object;
      if (!obj.dtacTile) continue;

      // for (let tile of [obj.dtacTile].concat(obj.dtacTile.links)) {
      //   let obj = tile.walkableObject;
      //   let oldMat = obj.material;
      //   obj.material = walkableObjectMaterial;
      //   oldIntersects.push([obj, oldMat]);
      // }


      let p = findPath(g_TestActor.tile, obj.dtacTile);
      for (let t of p) {
        let obj = t.walkableObject;
        let oldMat = obj.material;
        obj.material = walkableObjectMaterial;
        oldIntersects.push([obj, oldMat]);
      }

      if (g_DoMove && p[p.length-1] == obj.dtacTile) {
        // g_TestActor.setTile(obj.dtacTile)
        p.shift();
        g_CurrentAction = doTravel(g_TestActor, p);
      }
      g_DoMove = false;
    }
  }

  g_MainCameraControls.update();
	g_Renderer.render( g_World.scene, g_MainCamera );
}

function nextPowerOf2(x) {
  return Math.pow(2,Math.floor(Math.log(x)/Math.log(2)))
}

function isPowerOfTwo(x)
{
    return (x & (x - 1)) == 0;
}


/*
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