/* ─────────────────────────────────────────────────────────
   « Profondeur » — the background of every page

   Nothing is drawn. Some fifty thousand cells live in a 3D grid behind the
   page. Each one keeps a velocity: it leans towards the trail it senses
   ahead (Jones' Physarum, the rule that weaves the network) and keeps its
   momentum, so it glides instead of jittering; the larger cells are
   heavier, slower to turn and to go. Two families share the volume, each
   following its own trail and shying away from the other's: they divide
   the volume into territories.

   A camera looks into the volume through a thin lens: each cell is a grain
   of light, wider and softer away from the focal plane, and the focus
   wanders slowly through the depth. A cell's colour is its cloud's: where
   it stands between the blues and the crimsons comes from the share of the
   warm family around it, then from how thick that cloud is, each channel
   read a little apart as on the project blobs. The page gradient is that
   same light blurred over the whole screen — where the cells gather the
   sky lightens, where they leave the night shows.

   The cursor is a mass in the focal plane: the cells near it fall in,
   gather speed, curl around it and light up as they go; when it moves on,
   they drift back into the network. A finger is not a cursor: on touch
   screens there is no mass.

   WebGL2 + EXT_color_buffer_float, all on the GPU:
   1. cells — position (RGBA32F: xyz, size) and velocity (xyz, family),
      one two-target pass per step;
   2. trail — the 3D grid, stored as slices tiled in a 2D atlas (RG16F:
      cool density, warm density): the cells mark their grid cells
      (exclusion + deposit), the grid diffuses and evaporates, then its
      mipmaps give the cloud the colours read (and the mass of the optional
      gravity between cells);
   3. display — every cell is a point through the lens, drawn into one of
      four blur layers (1, 1/2, 1/4, 1/8 resolution) as wide as its blur;
      a pyramid of all that light gives the glow and, at its widest, the sky.

   The script makes its own canvas, behind the content (inside .page-bg
   where the page has one). <script data-calm> dims it for reading pages,
   and there the light under the copy falls out of focus: around the text
   the grains melt into the haze of their own light, so it reads on a calm
   ground while the margins keep the whole system.
   A small icon button, always at hand in the bottom right corner, turns the
   particles off and brings back the original CSS gradient; the choice is
   remembered from page to page, and while it is off nothing is even compiled.
   Without WebGL2 the canvas stays hidden, there is no button and the CSS
   gradient shows.
   Tuning lab: _lab/profondeur/ (not published).
───────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var me = document.currentScript;
  var calm = !!(me && me.hasAttribute('data-calm'));

  /* the canvas sits behind the content, above the CSS gradient that stays as a fallback;
     it is as tall as the screen with the mobile toolbars folded (lvh), so that folding
     them on scroll neither rescales the scene nor rebuilds the network */
  var style = document.createElement('style');
  style.textContent =
    '#profondeur-bg{position:fixed;top:0;left:0;width:100%;height:100vh;height:100lvh;display:block;z-index:-1;' +
    'pointer-events:none;opacity:0;transition:opacity 1.4s ease}' +
    'html.profondeur-on #profondeur-bg{opacity:1}' +
    'html.profondeur-on body,html.profondeur-on .page-bg{animation:none}' +
    /* the particles button: a small outlined, frosted square like the site's buttons */
    '.pg-particles{position:fixed;right:16px;bottom:16px;z-index:90;display:flex;align-items:center;justify-content:center;' +
    'width:30px;height:30px;padding:0;border:1px solid rgba(130,225,255,.5);color:rgb(130,225,255);' +
    'background:rgba(14,16,38,.5);-webkit-backdrop-filter:blur(45px) saturate(1.3);backdrop-filter:blur(45px) saturate(1.3);' +
    'cursor:pointer;transition:background .2s ease,border-color .2s ease,bottom .25s ease}' +
    '.pg-particles:hover{background:rgba(31,47,70,.54);border-color:rgb(130,225,255)}' +
    '.pg-particles:focus-visible{outline:2px solid rgb(130,225,255);outline-offset:3px}' +
    '.pg-particles svg{display:block}' +
    '@media (prefers-reduced-motion:reduce){.pg-particles{transition:none}}' +
    '@media print{.pg-particles{display:none}}';
  document.head.appendChild(style);
  var canvas = document.getElementById('profondeur-bg');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'profondeur-bg';
    canvas.setAttribute('aria-hidden', 'true');
    var host = document.querySelector('.page-bg') || document.body;
    host.insertBefore(canvas, host.firstChild);
  }

  var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
    console.warn('WebGL2 / EXT_color_buffer_float indisponible — dégradé CSS conservé');
    return;
  }

  /* particles or the original gradient: the visitor's choice, remembered across pages */
  var PREF = 'pg-particles';
  var enabled = true;
  try { enabled = localStorage.getItem(PREF) !== 'off'; } catch (e) { /* storage blocked: particles */ }

  var MAX_TEX = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  var MAX_POINT = Math.min(56, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]);
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TAU = Math.PI * 2, D2R = Math.PI / 180;
  var AW = 512;        /* cell textures are 512 wide */
  var RATIO = 2.6;     /* distance of the back of the volume / distance of its front */
  var RATE = 20;       /* simulation steps per second; the display interpolates */
  var PRE = 100;       /* steps run before the first frame, at four times the speed */
  var MAX_TEXT = 32;   /* boxes of copy the display knows at once (reading pages) */

  /* ─────────────────────────────────────────────────────────
     Shaders
  ───────────────────────────────────────────────────────── */
  var COMMON = `
uniform vec3  u_grid;     /* NX, NY, NZ */
uniform float u_cols;     /* slices per atlas row */
uniform vec2  u_atlas;    /* atlas size, texels */

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i),                     hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

/* slice z of the grid is the atlas tile (z mod cols, z div cols) */
vec2 tileOf(float z) { return vec2(mod(z, u_cols), floor(z / u_cols)) * u_grid.xy; }

/* trilinear read (bilinear inside two neighbouring slices); the grid wraps;
   lod > 0 reads the blurred trail */
vec4 trailAt(sampler2D t, vec3 p, float lod) {
  p = mod(p, u_grid);
  vec2 xy = clamp(p.xy, vec2(0.5), u_grid.xy - 0.5);
  float zf = p.z - 0.5, z0 = floor(zf);
  vec4 a = textureLod(t, (tileOf(mod(z0, u_grid.z)) + xy) / u_atlas, lod);
  vec4 b = textureLod(t, (tileOf(mod(z0 + 1.0, u_grid.z)) + xy) / u_atlas, lod);
  return mix(a, b, zf - z0);
}

/* atlas texel of the grid cell holding p (p inside the grid) */
ivec2 cellOf(vec3 p) {
  vec3 c = clamp(floor(p), vec3(0.0), u_grid - 1.0);
  return ivec2(tileOf(c.z) + c.xy);
}

`;

  var FS_VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  /* One step of every cell: sense, lean, fall, glide */
  var STEP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform sampler2D u_trail;
uniform sampler2D u_occ;    /* last step's deposit: about two cells' worth fills a grid cell */
` + COMMON + `
uniform float u_frame;
uniform float u_sa;         /* sensor angle */
uniform float u_so;         /* sensor reach, grid cells */
uniform float u_speed;      /* cruising speed, grid cells per step */
uniform float u_turn;       /* how fast the velocity leans towards the sensed way */
uniform float u_sharp;      /* how much the strongest sense wins */
uniform float u_gravity;    /* pull towards the mass around */
uniform float u_gLod;       /* blur of the mass gravity reads (mip level) */
uniform float u_gReach;     /* span of gravity's slope, grid cells */
uniform float u_drag;
uniform float u_cross;      /* how much a family shies away from the other's trail */
uniform float u_gCross;     /* how much its gravity leans away from the other's mass */
uniform float u_warmReach;  /* the warm family senses farther: wider loops */
uniform vec4  u_src[5];     /* project sources: xyz, radius (grid cells) */
uniform float u_srcK[5];
uniform vec4  u_cam;        /* rest eye xyz, focal length (css px) */
uniform vec2  u_view;       /* viewport, css px */
uniform vec4  u_block;      /* header copy box, css px */
uniform float u_blockK;
uniform vec4  u_well;       /* the cursor's mass: xyz (focal plane, grid cells), strength (signed) */
uniform float u_wellR;      /* its reach, grid cells */
layout(location = 0) out vec4 o_pos;
layout(location = 1) out vec4 o_vel;

/* where a point of the volume falls on the page (rest camera) */
vec2 toScreen(vec3 p) {
  float d = max(p.z - u_cam.z, 1.0);
  return vec2(0.5 * u_view.x + (p.x - u_cam.x) * u_cam.w / d,
              0.5 * u_view.y - (p.y - u_cam.y) * u_cam.w / d);
}

/* what a sense feels at p: the trail, the pull of the projects, the push of the copy
   along the line of sight */
float field(vec3 p, float trail) {
  float v = trail;
  for (int i = 0; i < 5; i++) {
    if (u_src[i].w > 0.0) {
      vec3 d = p - u_src[i].xyz;
      v += u_srcK[i] * exp(-dot(d, d) / (u_src[i].w * u_src[i].w));
    }
  }
  vec2 s = toScreen(p);
  vec2 o = max(max(u_block.xy - s, s - u_block.zw), 0.0);
  v -= u_blockK * exp(-dot(o, o) / 16900.0);
  return v;
}

/* a family reads its own trail, minus some of the other's; its gravity falls towards its
   own mass and leans away from the other's, so the families share the volume in
   territories rather than mixing */
vec2 kin, kinG;
float sense(vec3 p) { return field(p, dot(trailAt(u_trail, p, 0.0).rg, kin)); }
float mass(vec3 p) { return dot(trailAt(u_trail, p, u_gLod).rg, kinG); }

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(u_pos, ij, 0);
  vec4 V = texelFetch(u_vel, ij, 0);
  vec3 p = P.xyz, v = V.xyz;
  float warm = V.w;
  kin = warm > 0.5 ? vec2(-u_cross, 1.0) : vec2(1.0, -u_cross);
  kinG = warm > 0.5 ? vec2(-u_gCross, 1.0) : vec2(1.0, -u_gCross);
  float fm = mod(u_frame, 4096.0);
  vec3 rnd = hash33(vec3(vec2(ij), fm));

  /* its own weight: the larger cells are heavier, slower to turn and to go;
     the warm family is a little slower */
  float weight = 0.7 + 0.6 * P.w + 2.5 * pow(P.w, 8.0);
  float cruise = u_speed / sqrt(weight) * mix(1.0, 0.85, warm);
  float turn = u_turn / weight;

  float spd = length(v);
  vec3 h = spd > 1e-6 ? v / spd : normalize(rnd * 2.0 - 1.0 + vec3(1e-3));

  /* five senses: one ahead, four on a cone around the heading; the ring turns slowly */
  vec3 ref = abs(h.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 e1 = normalize(cross(h, ref)), e2 = cross(h, e1);
  float ph = P.w * 37.0 + u_frame * 0.011;
  vec3 a1 = cos(ph) * e1 + sin(ph) * e2, a2 = cos(ph) * e2 - sin(ph) * e1;
  /* their reach varies slowly across the volume: small cells here, wide ones there */
  float n = vnoise(p / 40.0 + vec3(u_frame * 0.0003, -u_frame * 0.0002, u_frame * 0.00025));
  float so = u_so * (0.55 + 1.1 * n * n) * mix(1.0, u_warmReach, warm);
  float cs = cos(u_sa), sn = sin(u_sa);
  vec3 d0 = h, d1 = cs * h + sn * a1, d2 = cs * h - sn * a1, d3 = cs * h + sn * a2, d4 = cs * h - sn * a2;
  float f0 = sense(p + so * d0), f1 = sense(p + so * d1), f2 = sense(p + so * d2);
  float f3 = sense(p + so * d3), f4 = sense(p + so * d4);

  /* the way it would like to go: each sense weighed by what it feels, the strongest by far */
  float top = max(max(max(f0, f1), max(f2, f3)), f4);
  vec3 want = d0 * exp((f0 - top) * u_sharp) + d1 * exp((f1 - top) * u_sharp) + d2 * exp((f2 - top) * u_sharp)
            + d3 * exp((f3 - top) * u_sharp) + d4 * exp((f4 - top) * u_sharp);
  want = length(want) > 1e-5 ? normalize(want) : h;

  /* gravity: down the slope of the mass around (the trail, blurred), saturating */
  vec3 pull = vec3(0.0);
  if (u_gravity > 0.0) {
    float r = u_gReach;
    vec3 g = vec3(mass(p + vec3(r, 0.0, 0.0)) - mass(p - vec3(r, 0.0, 0.0)),
                  mass(p + vec3(0.0, r, 0.0)) - mass(p - vec3(0.0, r, 0.0)),
                  mass(p + vec3(0.0, 0.0, r)) - mass(p - vec3(0.0, 0.0, r)));
    float gl = length(g);
    pull = gl > 1e-6 ? g / gl * smoothstep(0.0, 0.6, gl) : vec3(0.0);
  }

  /* the cursor's well: 1/r² with a flat core, nothing far away, and a soft repulsive heart,
     so falling cells settle into a ring around the pointer instead of piling up; a swirl
     around the line of sight makes them circle it */
  vec3 dw = u_well.xyz - p;
  float r2 = dot(dw, dw);
  float held = u_well.w != 0.0 ? exp(-r2 / (u_wellR * u_wellR)) : 0.0;
  vec3 radial = dw * inversesqrt(r2 + 1e-4);
  vec3 swirl = normalize(cross(vec3(0.0, 0.0, 1.0), radial) + vec3(1e-5));
  /* each cell has its own orbit: the ring thickens into a swirling disc */
  float ring = u_wellR * 0.25 * (0.45 + 1.1 * hash13(vec3(vec2(ij), 5.0)));
  float fallK = clamp((1.0 - ring * ring / max(r2, 1e-3)) / (1.0 + r2 / (1.4 * ring * 1.4 * ring)), -0.6, 1.0);
  vec3 fall = (radial * fallK + swirl * 0.6 * sign(u_well.w) * min(1.0, ring * ring / max(r2, 1e-3)))
            * (u_well.w * 0.05 * held);
  /* pressure: in a crowded knot gravity gives way to agitation, so knots stay loose
     instead of packing into the grid */
  vec4 here = trailAt(u_trail, p, 0.0);
  float crowd = smoothstep(3.0, 9.0, here.r + here.g);

  /* the velocity leans towards that way at cruising speed, falls with the mass and
     keeps its momentum: the cell glides instead of jittering */
  /* (in the well, the fall wins over the senses and the speed limit) */
  v += (want * cruise - v) * turn * (1.0 - 0.85 * held);
  v += pull * (u_gravity * cruise * 0.12 * (1.0 - crowd));
  v += fall;
  v += (rnd - 0.5) * (cruise * (0.04 + 0.35 * crowd) + 0.06 * held * abs(u_well.w));
  v *= 1.0 - u_drag - 0.015 * held;
  float l = length(v), cap = 2.5 * cruise + 1.6 * held;
  if (l > cap) v *= cap / l;

  vec3 np = mod(p + v, u_grid);
  /* two cells at most per grid cell (after Jones): a full one turns it back, softly
     (not in the cursor's well, where the cells fly past each other) */
  vec4 taken = texelFetch(u_occ, cellOf(np), 0);
  if (held < 0.3 && any(notEqual(floor(np), floor(p))) && taken.r + taken.g > 1.6) {
    np = p;
    v = -v * 0.3 + (rnd - 0.5) * (cruise * 0.3);
  }

  o_pos = vec4(np, P.w);
  o_vel = vec4(v, warm);
}`;

  /* Every cell leaves its deposit in its grid cell, in its family's channel; the next
     step reads a deposit of about two cells as a full grid cell */
  var MARK_VERT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_pos;
uniform sampler2D u_vel;
` + COMMON + `
uniform int   u_aw;
uniform float u_deposit;
out vec2 v_val;
void main() {
  ivec2 ij = ivec2(gl_VertexID % u_aw, gl_VertexID / u_aw);
  vec4 P = texelFetch(u_pos, ij, 0);
  float warm = texelFetch(u_vel, ij, 0).w;
  vec2 t = vec2(cellOf(P.xyz)) + 0.5;
  gl_Position = vec4(t / u_atlas * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  /* larger cells weigh more on the trail, and so on gravity */
  float dep = u_deposit * (0.6 + 0.8 * P.w + 2.0 * pow(P.w, 8.0));
  v_val = warm > 0.5 ? vec2(0.0, dep) : vec2(dep, 0.0);
}`;

  var MARK_FRAG = `#version 300 es
precision highp float;
in vec2 v_val;
out vec4 o;
void main() { o = vec4(v_val, 0.0, 0.0); }`;

  /* Trail: partial 7-point diffusion in 3D (keeps the walls thin), evaporation, deposit */
  var DIFFUSE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_trail;
uniform sampler2D u_occ;
` + COMMON + `
uniform float u_decay;
uniform float u_diffuse;
uniform float u_voids;
uniform float u_frame;
out vec4 o;

ivec2 at(ivec2 g, int cols, int x, int y, int z) {
  return ivec2((z % cols) * g.x + x, (z / cols) * g.y + y);
}

void main() {
  ivec2 g = ivec2(u_grid.xy);
  int cols = int(u_cols), nz = int(u_grid.z);
  ivec2 ij = ivec2(gl_FragCoord.xy);
  ivec2 tile = ij / g;
  int z = tile.x + tile.y * cols;
  if (z >= nz) { o = vec4(0.0); return; }
  ivec2 l = ij - tile * g;
  vec4 c = texelFetch(u_trail, ij, 0);
  vec4 s = c
    + texelFetch(u_trail, at(g, cols, (l.x + 1) % g.x, l.y, z), 0)
    + texelFetch(u_trail, at(g, cols, (l.x + g.x - 1) % g.x, l.y, z), 0)
    + texelFetch(u_trail, at(g, cols, l.x, (l.y + 1) % g.y, z), 0)
    + texelFetch(u_trail, at(g, cols, l.x, (l.y + g.y - 1) % g.y, z), 0)
    + texelFetch(u_trail, at(g, cols, l.x, l.y, (z + 1) % nz), 0)
    + texelFetch(u_trail, at(g, cols, l.x, l.y, (z + nz - 1) % nz), 0);
  /* in some slowly drifting regions the trail evaporates faster: voids open there */
  vec3 q = vec3(vec2(l), float(z)) / 56.0 + vec3(-u_frame * 0.00015, u_frame * 0.0001, u_frame * 0.00008);
  float decay = u_decay - u_voids * smoothstep(0.45, 0.8, vnoise(q));
  o = vec4(mix(c.rg, s.rg / 7.0, u_diffuse) * decay + texelFetch(u_occ, ij, 0).rg, 0.0, 1.0);
}`;

  /* Display, 1: each cell through a thin lens — a grain in focus, a disc out of it.
     Each blur is drawn into the layer whose resolution matches it (half per octave),
     so a wide disc costs no more than a grain; one pass per layer. */
  var POINTS_VERT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_pos;
uniform sampler2D u_prev;
uniform sampler2D u_vel;
uniform sampler2D u_trail;
` + COMMON + `
uniform int   u_aw;
uniform mat4  u_viewM;
uniform mat4  u_projM;
uniform float u_alpha;      /* between the last two steps */
uniform float u_focus;      /* focal distance, grid cells */
uniform float u_coc;        /* circle of confusion scale, device px */
uniform float u_dpr;
uniform float u_maxPoint;
uniform float u_gain;
uniform float u_densK;
uniform float u_bokeh;
uniform float u_time;
uniform float u_layer;      /* 0 sharp (full resolution) … 3 widest (1/8) */
uniform float u_iri;        /* how much the cells shimmer */
uniform float u_cloudK;     /* how fast the film thickens with the cloud */
out vec3  v_col;
out float v_soft;
out float v_rim;

/* one spectrum for the whole system, from the cool territories to the warm ones:
   deep blue, azure, periwinkle, violet, magenta, crimson, rose */
vec3 tint(int i) {
  if (i == 0) return vec3(0.10, 0.28, 1.00);
  if (i == 1) return vec3(0.25, 0.55, 1.00);
  if (i == 2) return vec3(0.45, 0.40, 1.00);
  if (i == 3) return vec3(0.55, 0.16, 0.92);
  if (i == 4) return vec3(0.86, 0.10, 0.78);
  if (i == 5) return vec3(0.95, 0.14, 0.38);
  return vec3(1.00, 0.45, 0.68);
}
vec3 film(float t) {
  t = clamp(t, 0.0, 1.0) * 6.0;
  int i = min(int(t), 5);
  float f = t - float(i);
  f = f * f * (3.0 - 2.0 * f);
  return mix(tint(i), tint(i + 1), f);
}
/* as on the blobs, each channel reads the film a little apart: fringes of colour */
vec3 iridescent(float t) {
  return vec3(film(t + 0.06).r, film(t).g, film(t - 0.06).b);
}

void hide() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  v_col = vec3(0.0); v_soft = 0.0; v_rim = 0.0;
}

void main() {
  ivec2 ij = ivec2(gl_VertexID % u_aw, gl_VertexID / u_aw);
  vec4 P = texelFetch(u_pos, ij, 0);
  vec3 q = texelFetch(u_prev, ij, 0).xyz;
  vec3 p = P.xyz;
  if (all(lessThan(abs(p - q), 0.5 * u_grid))) p = mix(q, p, u_alpha);
  vec4 vp = u_viewM * vec4(p, 1.0);
  float D = -vp.z;

  /* apparent size: the cell's own size in perspective, widened by the lens blur */
  float s0 = u_dpr * (0.7 + 2.6 * pow(P.w, 6.0)) * u_focus / max(D, 1.0);
  float c = u_coc * abs(D - u_focus) / max(D, 1.0);
  float lambda = clamp(log2(max(c, 1.0)) - 1.0, 0.0, 3.0);
  float w = 1.0 - abs(lambda - u_layer);
  if (D < 2.0 || w <= 0.0) { hide(); return; }
  gl_Position = u_projM * vp;
  float scale = exp2(u_layer);
  float size = clamp(sqrt(s0 * s0 + c * c) / scale, 1.0, u_maxPoint);
  gl_PointSize = size;

  vec4 V = texelFetch(u_vel, ij, 0);
  vec4 tr = trailAt(u_trail, p, 0.0);
  float dens = 1.0 - exp(-(tr.r + tr.g) * u_densK);
  /* a cell lights up with its speed: the ones falling into the cursor's well glow */
  float lum = u_gain * (0.3 + 0.7 * hash13(vec3(vec2(ij), 7.0))) * (0.2 + dens)
            * (1.0 + 1.5 * smoothstep(0.08, 1.2, length(V.xyz)));
  /* the colour is the cloud's, not the cell's: where it stands in the spectrum comes from
     the share of the warm family in the cloud around (blurred wide), then from how thick
     that cloud is; so neighbours share a tint, the territories read blue or crimson and
     their fronts violet and magenta; the crowd, the way the cell moves across the line of
     sight and a slow drift move it a little more */
  float sp = length(V.xyz);
  vec3 mv = sp > 1e-6 ? mat3(u_viewM) * (V.xyz / sp) : vec3(0.0, 0.0, 1.0);
  float across = 1.0 - abs(mv.z);
  vec4 cloud = trailAt(u_trail, p, 3.0);
  float share = (cloud.g + 0.02) / (cloud.r + cloud.g + 0.04);
  float thick = 1.0 - exp(-(cloud.r + cloud.g) * u_cloudK);
  float t = 0.08 + 0.62 * share + 0.18 * thick + 0.05 * dens + 0.04 * across
          + 0.12 * (vnoise(p / 90.0 + vec3(0.0, u_time * 0.01, 0.0)) - 0.5);
  vec3 col = mix(film(0.08 + 0.62 * share), iridescent(t), u_iri);
  /* the densest knots pale: cyan in the cool territories, rose in the warm ones */
  col = mix(col, mix(vec3(0.5, 0.84, 1.0), vec3(1.0, 0.62, 0.85), share), smoothstep(0.7, 0.97, dens) * 0.45);
  /* light fades in at the front of the volume and out at its back, where the grid wraps */
  float fade = smoothstep(0.0, 6.0, p.z) * (1.0 - smoothstep(u_grid.z - 12.0, u_grid.z, p.z));
  /* the light of the cell (its apparent area) spreads over the disc, measured in screen px */
  float sf = size * scale;
  float spread = sf * sf * mix(1.15, 0.25, smoothstep(1.0, 2.5, size));
  float outOfFocus = smoothstep(2.0, 16.0, c);
  v_col = col * lum * fade * w * s0 * s0 / spread * (1.0 + u_bokeh * outOfFocus);
  v_soft = smoothstep(0.6, 2.0, c / max(s0, 1.0));
  v_rim = smoothstep(10.0, 28.0, c) * pow(0.5 + 0.5 * sin(u_time * 0.35 + P.w * 61.0), 10.0);
}`;

  var POINTS_FRAG = `#version 300 es
precision highp float;
in vec3  v_col;
in float v_soft;
in float v_rim;
out vec4 o;
float ring(float r) { return smoothstep(0.76, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r)); }
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  float grain = exp(-r * r * 3.5) * 1.15;
  float disc = (1.0 - smoothstep(0.75, 1.0, r)) * 0.42;
  vec3 c = v_col * mix(grain, disc, v_soft);
  /* now and then a defocused disc shows the blobs' fringe: its rim splits into magenta and cyan */
  c += v_rim * length(v_col) * vec3(ring(r * 0.965) * 0.9, ring(r) * 0.25, ring(r * 1.035)) * 1.6;
  o = vec4(c, 1.0);
}`;

  /* smooth (B-spline) read of a small texture: no blocks, no diamonds */
  var BICUBIC = `
vec4 cubic(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}
vec4 bicubic(sampler2D t, vec2 uv, vec2 res) {
  uv = uv * res - 0.5;
  vec2 f = fract(uv);
  uv -= f;
  vec4 xc = cubic(f.x), yc = cubic(f.y);
  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) / res.xxyy;
  vec4 s0 = texture(t, off.xz), s1 = texture(t, off.yz), s2 = texture(t, off.xw), s3 = texture(t, off.yw);
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
`;

  /* Display, 2: all the light at half resolution, the base of the pyramid */
  var MERGE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_l0;
uniform sampler2D u_l1;
uniform sampler2D u_l2;
uniform sampler2D u_l3;
uniform vec2 u_dst;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_dst;
  o = texture(u_l0, uv) + texture(u_l1, uv) + texture(u_l2, uv) + texture(u_l3, uv);
}`;

  /* Display, 3: blur pyramid (dual filter) — glow, then sky */
  var DOWN_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_texel;       /* source texel */
uniform vec2 u_dst;         /* destination size */
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_dst;
  vec2 h = u_texel;
  vec4 s = texture(u_src, uv) * 4.0;
  s += texture(u_src, uv - h);
  s += texture(u_src, uv + h);
  s += texture(u_src, uv + vec2(h.x, -h.y));
  s += texture(u_src, uv - vec2(h.x, -h.y));
  o = s / 8.0;
}`;

  var UP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_coarse;
uniform sampler2D u_fine;
uniform vec2  u_texel;      /* coarse texel */
uniform vec2  u_dst;
uniform float u_keep;       /* share of the finer level */
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_dst;
  vec2 h = u_texel * 0.5;
  vec4 s = texture(u_coarse, uv + vec2(-2.0 * h.x, 0.0));
  s += texture(u_coarse, uv + vec2(-h.x, h.y)) * 2.0;
  s += texture(u_coarse, uv + vec2(0.0, 2.0 * h.y));
  s += texture(u_coarse, uv + vec2(h.x, h.y)) * 2.0;
  s += texture(u_coarse, uv + vec2(2.0 * h.x, 0.0));
  s += texture(u_coarse, uv + vec2(h.x, -h.y)) * 2.0;
  s += texture(u_coarse, uv + vec2(0.0, -2.0 * h.y));
  s += texture(u_coarse, uv + vec2(-h.x, -h.y)) * 2.0;
  o = mix(s / 12.0, texture(u_fine, uv), u_keep);
}`;

  /* Display, 4: everything soft at half resolution — the wider layers, the glow and the
     sky (the system's light at its widest). On reading pages the light under the copy
     falls out of focus: there the grains, the discs and their glow give way to the same
     light blurred wider, the haze; how far it has gone goes out in alpha, for the grains
     of the last pass */
  var SOFT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_l1;
uniform sampler2D u_l2;
uniform sampler2D u_l3;
uniform sampler2D u_glow;
uniform sampler2D u_sky;
uniform sampler2D u_haze;
uniform vec2  u_dst;
uniform vec2  u_r2;
uniform vec2  u_r3;
uniform vec2  u_skyRes;
uniform vec2  u_hazeRes;
uniform float u_glowK;
uniform float u_skyK;
uniform float u_split;      /* the glow's colour split on its edges, texels */
uniform vec4  u_text[${MAX_TEXT}];  /* the copy in view, css px from the top left */
uniform int   u_textN;
uniform vec2  u_css;        /* the canvas, css px */
uniform float u_read;       /* how far the light under the copy falls out of focus */
uniform float u_readReach;  /* over how many css px around it */
out vec4 o;
` + BICUBIC + `
float lum(vec3 c) { return dot(c, vec3(0.3, 0.45, 0.25)); }
float underCopy(vec2 p) {
  float d = 1e10;
  for (int i = 0; i < ${MAX_TEXT}; i++) {
    if (i >= u_textN) break;
    vec2 q = max(max(u_text[i].xy - p, p - u_text[i].zw), 0.0);
    d = min(d, dot(q, q));
  }
  return 1.0 - smoothstep(0.0, u_readReach, sqrt(d));
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_dst, e = 1.5 / u_dst;
  /* the clouds' edges split like the blobs': the channels slide apart along the slope */
  vec2 g = vec2(lum(texture(u_glow, uv + vec2(e.x, 0.0)).rgb) - lum(texture(u_glow, uv - vec2(e.x, 0.0)).rgb),
                lum(texture(u_glow, uv + vec2(0.0, e.y)).rgb) - lum(texture(u_glow, uv - vec2(0.0, e.y)).rgb));
  vec2 off = g / (length(g) + 1e-4) * u_split * smoothstep(0.0, 0.02, length(g)) / u_dst;
  vec3 glow = vec3(texture(u_glow, uv + off).r, texture(u_glow, uv).g, texture(u_glow, uv - off).b);
  vec3 near = texture(u_l1, uv).rgb + bicubic(u_l2, uv, u_r2).rgb + bicubic(u_l3, uv, u_r3).rgb + glow * u_glowK;
  float m = u_textN > 0 ? u_read * underCopy(vec2(uv.x, 1.0 - uv.y) * u_css) : 0.0;
  /* the haze carries the light of every layer, the sharp grains' too */
  vec3 haze = bicubic(u_haze, uv, u_hazeRes).rgb * (1.0 + u_glowK);
  o = vec4(mix(near, haze, m) + bicubic(u_sky, uv, u_skyRes).rgb * u_skyK, m);
}`;

  /* Display, 5: the night, the soft light, the sharp grains (split a little by the lens
     towards the edges of the frame) */
  var COMPOSE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D u_l0;
uniform sampler2D u_soft;
uniform vec2  u_res;
uniform float u_amount;
uniform float u_fringe;
uniform float u_dpr;
uniform vec4  u_veil;       /* header copy, device px */
uniform vec4  u_veil2;      /* footer line */
uniform float u_readDim;    /* how much the haze under the copy dims */
out vec4 o;

const vec3 NIGHT = vec3(0.030, 0.008, 0.052);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/* the light dims behind the copy, softly, so the text keeps its contrast */
float veilAt(vec4 box, vec2 fc, float floorK, float reach) {
  vec2 d = max(max(box.xy - fc, fc - box.zw), 0.0);
  return mix(floorK, 1.0, smoothstep(0.0, reach * u_dpr, length(d)));
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = fc / u_res;
  vec2 ca = (uv - 0.5) * u_fringe * u_dpr;
  vec3 pts = vec3(texture(u_l0, (fc + ca) / u_res).r,
                  texelFetch(u_l0, ivec2(fc), 0).g,
                  texture(u_l0, (fc - ca) / u_res).b);
  float veil = veilAt(u_veil, fc, 0.5, 150.0) * veilAt(u_veil2, fc, 0.45, 70.0);
  /* under the copy of the reading pages the sharp grains are already in the haze */
  vec4 soft = texture(u_soft, uv);
  vec3 light = (pts * (1.0 - soft.a) + soft.rgb) * u_amount * veil * (1.0 - u_readDim * soft.a);
  vec3 col = 1.0 - (1.0 - NIGHT) * exp(-light);
  col += (hash12(fc) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;

  var P = null, U = null, vaoTri = null, vaoCells = null, bufIds = null, broken = false;

  /* programs and buffers, made on first use — never, while the visitor keeps the gradient */
  function init() {
    if (P || broken) return !broken;
    var made = {
      step: createProgram(FS_VERT, STEP_FRAG),
      mark: createProgram(MARK_VERT, MARK_FRAG),
      diffuse: createProgram(FS_VERT, DIFFUSE_FRAG),
      points: createProgram(POINTS_VERT, POINTS_FRAG),
      merge: createProgram(FS_VERT, MERGE_FRAG),
      down: createProgram(FS_VERT, DOWN_FRAG),
      up: createProgram(FS_VERT, UP_FRAG),
      soft: createProgram(FS_VERT, SOFT_FRAG),
      compose: createProgram(FS_VERT, COMPOSE_FRAG)
    };
    for (var name in made) if (!made[name]) { broken = true; return false; }
    P = made;

    var GRID = ['u_grid', 'u_cols', 'u_atlas'];
    U = {
      step: uniforms(P.step, GRID.concat(['u_pos', 'u_vel', 'u_trail', 'u_occ', 'u_frame', 'u_sa', 'u_so', 'u_speed',
        'u_turn', 'u_sharp', 'u_gravity', 'u_gLod', 'u_gReach', 'u_drag', 'u_cross', 'u_gCross', 'u_warmReach', 'u_src', 'u_srcK',
        'u_cam', 'u_view', 'u_block', 'u_blockK', 'u_well', 'u_wellR'])),
      mark: uniforms(P.mark, GRID.concat(['u_pos', 'u_vel', 'u_aw', 'u_deposit'])),
      diffuse: uniforms(P.diffuse, GRID.concat(['u_trail', 'u_occ', 'u_decay', 'u_diffuse', 'u_voids', 'u_frame'])),
      points: uniforms(P.points, GRID.concat(['u_pos', 'u_prev', 'u_vel', 'u_trail', 'u_aw', 'u_viewM', 'u_projM',
        'u_alpha', 'u_focus', 'u_coc', 'u_dpr', 'u_maxPoint', 'u_gain', 'u_densK', 'u_bokeh', 'u_time', 'u_layer',
        'u_iri', 'u_cloudK'])),
      merge: uniforms(P.merge, ['u_l0', 'u_l1', 'u_l2', 'u_l3', 'u_dst']),
      down: uniforms(P.down, ['u_src', 'u_texel', 'u_dst']),
      up: uniforms(P.up, ['u_coarse', 'u_fine', 'u_texel', 'u_dst', 'u_keep']),
      soft: uniforms(P.soft, ['u_l1', 'u_l2', 'u_l3', 'u_glow', 'u_sky', 'u_haze', 'u_dst', 'u_r2', 'u_r3', 'u_skyRes',
        'u_hazeRes', 'u_glowK', 'u_skyK', 'u_split', 'u_text', 'u_textN', 'u_css', 'u_read', 'u_readReach']),
      compose: uniforms(P.compose, ['u_l0', 'u_soft', 'u_res', 'u_amount', 'u_fringe', 'u_dpr', 'u_veil', 'u_veil2',
        'u_readDim'])
    };

    vaoTri = gl.createVertexArray();
    gl.bindVertexArray(vaoTri);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    /* one vertex per cell; the id comes from gl_VertexID, the buffer only keeps drivers happy */
    vaoCells = gl.createVertexArray();
    bufIds = gl.createBuffer();
    gl.bindVertexArray(vaoCells);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufIds);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return true;
  }

  /* ─────────────────────────────────────────────────────────
     State
  ───────────────────────────────────────────────────────── */
  /* Regimes of the same system: only the cells' senses change */
  var REGIMES = {
    cells:     { sa: 30, so: 4.5, turn: 0.22, sharp: 2.5, decay: 0.9,  deposit: 1, diffuse: 0.45 },
    filaments: { sa: 38, so: 6.5, turn: 0.1,  sharp: 2.0, decay: 0.94, deposit: 1, diffuse: 0.3 }
  };
  var DRIFT = ['cells', 'cells', 'filaments'];

  var state = {
    mode: 1, regime: 'drift', fill: 0.02, speed: 0.5, gravity: 0, amount: 1.5, sky: 3, glow: 1, dof: 1.25,
    well: 1.2, wellR: 28, bokeh: 0.6, gain: 0.9, densK: 0.25, food: 0.5, blockK: 1.5, voids: 0.06, drag: 0.02,
    gLod: 2, gReach: 6, warm: 0.3, cross: 0.45, gCross: 0.15, warmReach: 1.35, iri: 1, cloudK: 1.2, split: 6, fringe: 1.2,
    read: 0, readDim: 0.35, readReach: 72, haze: 20,
    focusDrift: true, drift: true, parallax: true, sources: true, avoid: true, cursor: true, veil: true,
    paused: false
  };

  /* reading pages: less light behind the text, a gentler cursor, and the light under the
     copy out of focus */
  if (calm) { state.amount *= 0.6; state.sky *= 0.75; state.well *= 0.6; state.read = 0.9; }

  var NX = 0, NY = 0, NZ = 0, cols = 1, atlasW = 0, atlasH = 0, AH = 0, count = 0, levels = 1;
  var camD = 0, tanH = 0.6;
  var agA, agB, trailA, trailB, occ;
  var layers = [], down = [], up = [], soft = null, skyLevel = 0, screenKey = '';
  var frame = 0, simTime = 0, acc = 0, lastNow = 0, startAt = performance.now();
  var raf = 0, shown = false, built = '', boost = 1;
  var quality = 1, frames = 0, frameAcc = 0;
  var mouse = { x: -1e4, y: -1e4, k: 0, kt: 0 };
  var par = { x: 0, y: 0, tx: 0, ty: 0 };
  var hover = [0, 0, 0, 0, 0], hoverTarget = [0, 0, 0, 0, 0];
  var view = new Float32Array(16), proj = new Float32Array(16), focus = 0;

  /* only a mouse or a pen holds the well: a finger lifts without a pointerleave, which
     would leave the well (and the parallax) stuck where the last scroll began */
  window.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.kt = 1;
    par.tx = e.clientX / Math.max(innerWidth, 1) - 0.5;
    par.ty = e.clientY / Math.max(innerHeight, 1) - 0.5;
  }, { passive: true });
  document.addEventListener('pointerleave', function () { mouse.kt = 0; par.tx = 0; par.ty = 0; });

  document.querySelectorAll('.project-card').forEach(function (card, k) {
    if (k > 4) return;
    var on = function () { hoverTarget[k] = 1; };
    var off = function () { hoverTarget[k] = 0; };
    card.addEventListener('pointerenter', on);
    card.addEventListener('pointerleave', off);
    card.addEventListener('focus', on);
    card.addEventListener('blur', off);
  });

  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    cancelAnimationFrame(raf); raf = 0;
    document.documentElement.classList.remove('profondeur-on');
    toggle.hidden = true;
  });

  /* ≤ 1.5 dpr and ≤ ~2.4 Mpx for the display */
  function resize() {
    var W = canvas.clientWidth, H = canvas.clientHeight;
    var s = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2.4e6 / Math.max(W * H, 1))) * quality;
    var bw = Math.max(1, Math.round(W * s)), bh = Math.max(1, Math.round(H * s));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw; canvas.height = bh;
    }
  }

  /* Header copy, footer line and the five project blobs (css px) */
  var veilCss = [0, 0, 0, 0], footCss = [0, 0, 0, 0], blobs = [];

  function measureLayout() {
    var rects = function (sel) {
      return Array.prototype.map.call(document.querySelectorAll(sel), function (el) {
        return el.getBoundingClientRect();
      });
    };
    var box = function (list) {
      return list.length ? [
        Math.min.apply(null, list.map(function (b) { return b.left; })),
        Math.min.apply(null, list.map(function (b) { return b.top; })),
        Math.max.apply(null, list.map(function (b) { return b.right; })),
        Math.max.apply(null, list.map(function (b) { return b.bottom; }))
      ] : [-1e5, -1e5, -1e5, -1e5];
    };
    veilCss = box(rects('.site-title, .hero-text'));
    footCss = box(rects('.footer-text, .social-links'));
    blobs = rects('.project-figure').slice(0, 5);
    if (textDirty && calm) measureCopy();
  }

  /* Reading pages: where the copy stands on the page (css px, page coordinates), merged
     into blocks. Text on a frosted card, a tag, a button or a fixed bar is left out: it
     has its own ground already. Measured again whenever the page reflows. */
  var copyPage = [], textDirty = true, textBoxes = new Float32Array(4 * MAX_TEXT), textN = 0;

  function measureCopy() {
    textDirty = false;
    var apart = new Map(), found = [], range = document.createRange();
    var standsApart = function (el) {
      var path = [], verdict = false;
      for (var e = el; e && e !== document.body; e = e.parentElement) {
        if (apart.has(e)) { verdict = apart.get(e); break; }
        path.push(e);
        var cs = getComputedStyle(e), frost = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|BUTTON)$/.test(e.tagName) || frost !== 'none' ||
            cs.position === 'fixed' || cs.position === 'sticky') { verdict = true; break; }
      }
      path.forEach(function (e) { apart.set(e, verdict); });
      return verdict;
    };
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (standsApart(n.parentElement)) continue;
      range.selectNodeContents(n);
      var r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      found.push([r.left + scrollX, r.top + scrollY, r.right + scrollX, r.bottom + scrollY]);
    }
    /* the lines and the runs of a paragraph, and the paragraphs that touch, make one block */
    copyPage = mergeBoxes(found, 12);
  }

  /* boxes nearer to each other than `join` (css px) become one */
  function mergeBoxes(list, join) {
    var boxes = list.slice(), merged = true;
    while (merged) {
      merged = false;
      for (var i = 0; i < boxes.length && !merged; i++) {
        for (var j = i + 1; j < boxes.length; j++) {
          var a = boxes[i], b = boxes[j];
          if (a[0] - join <= b[2] && b[0] - join <= a[2] && a[1] - join <= b[3] && b[1] - join <= a[3]) {
            boxes[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            boxes.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
    }
    return boxes;
  }

  function reading() { return calm && state.read > 0 && state.veil; }

  /* the blocks in view, from the top left of the canvas, a little wider than the glyphs;
     if they are too many, the nearest merge */
  function copyInView() {
    textN = 0;
    if (!reading()) return;
    var W = canvas.clientWidth, H = canvas.clientHeight, reach = state.readReach, pad = 8;
    var seen = [];
    copyPage.forEach(function (b) {
      var x0 = b[0] - scrollX - pad, y0 = b[1] - scrollY - pad, x1 = b[2] - scrollX + pad, y1 = b[3] - scrollY + pad;
      if (x1 > -reach && x0 < W + reach && y1 > -reach && y0 < H + reach) seen.push([x0, y0, x1, y1]);
    });
    for (var join = 24; seen.length > MAX_TEXT; join *= 2) seen = mergeBoxes(seen, join);
    seen.forEach(function (b, k) { textBoxes.set(b, k * 4); });
    textN = seen.length;
  }

  /* the copy moves when the page reflows: width, images, fonts; with reduced motion the
     still frame is drawn again when the page reflows or scrolls, for the haze to follow */
  function reflowed() { textDirty = true; if (reduced) kick(); }
  if (calm) {
    window.addEventListener('resize', reflowed);
    window.addEventListener('load', reflowed);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(reflowed);
    if (window.ResizeObserver) new ResizeObserver(reflowed).observe(document.body);
    if (reduced) window.addEventListener('scroll', function () { kick(); }, { passive: true });
  }

  /* ─────────────────────────────────────────────────────────
     Targets
  ───────────────────────────────────────────────────────── */
  /* one framebuffer with one or more textures: [internal, format, type, filter, data];
     mips > 0 allocates a mipmapped texture */
  function target(w, h, specs, mips) {
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    var tex = specs.map(function (s, i) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (mips) {
        gl.texStorage2D(gl.TEXTURE_2D, mips, s[0], w, h);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, s[0], w, h, 0, s[1], s[2], s[4] || null);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : s[3]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, s[3]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      return t;
    });
    if (tex.length > 1) gl.drawBuffers(tex.map(function (t, i) { return gl.COLOR_ATTACHMENT0 + i; }));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo: fbo, tex: tex, w: w, h: h };
  }

  function drop(tg) {
    if (!tg) return;
    tg.tex.forEach(function (t) { gl.deleteTexture(t); });
    gl.deleteFramebuffer(tg.fbo);
  }

  function clearTarget(tg) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, tg.fbo);
    gl.viewport(0, 0, tg.w, tg.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function mipmaps(tg) {
    gl.bindTexture(gl.TEXTURE_2D, tg.tex[0]);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  var F32 = function (data) { return [gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, data]; };
  var F16 = function (filter) { return [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, filter]; };
  var RG16 = function (filter) { return [gl.RG16F, gl.RG, gl.HALF_FLOAT, filter]; };

  /* ─────────────────────────────────────────────────────────
     Build: the grid fits the view frustum at the back of the
     volume, cells scattered through it
  ───────────────────────────────────────────────────────── */
  function build() {
    var W = canvas.clientWidth, H = canvas.clientHeight, aspect = W / Math.max(H, 1);
    var small = W < 700;
    NZ = small ? 40 : 64;
    var budget = small ? 0.8e6 : 2.3e6;
    /* multiples of 8, so that the mipmaps of the slices stay apart */
    NY = Math.max(48, Math.round(Math.sqrt(budget / (NZ * aspect)) / 8) * 8);
    NX = Math.max(48, Math.round(NY * aspect / 8) * 8);
    cols = Math.max(1, Math.round(Math.sqrt(NZ * NY / NX)));
    while (cols > 1 && cols * NX > MAX_TEX) cols--;
    var rows = Math.ceil(NZ / cols);
    atlasW = cols * NX; atlasH = rows * NY;
    levels = 4;

    /* the camera sits in front of the volume; the frustum just fits its back face */
    camD = NZ / (RATIO - 1);
    tanH = Math.min(0.45 * NY / (camD + NZ), 0.45 * NX / ((camD + NZ) * aspect));

    count = Math.min(1 << 19, Math.max(8192, Math.round(NX * NY * NZ * state.fill / AW) * AW));
    AH = count / AW;
    var rnd = mulberry32(Math.floor(performance.now()) & 0xffff);
    var pos = new Float32Array(count * 4), vel = new Float32Array(count * 4);
    var v0 = state.speed / RATE;
    for (var i = 0; i < count; i++) {
      var x = rnd() * NX, y = rnd() * NY, z = rnd() * NZ;
      var cz = rnd() * 2 - 1, th = rnd() * TAU, r = Math.sqrt(1 - cz * cz);
      pos[i * 4] = x; pos[i * 4 + 1] = y; pos[i * 4 + 2] = z; pos[i * 4 + 3] = rnd();
      vel[i * 4] = r * Math.cos(th) * v0; vel[i * 4 + 1] = r * Math.sin(th) * v0; vel[i * 4 + 2] = cz * v0;
      /* the family: cool (0) or warm (1) */
      vel[i * 4 + 3] = rnd() < state.warm ? 1 : 0;
    }

    drop(agA); drop(agB); drop(trailA); drop(trailB); drop(occ);
    agA = target(AW, AH, [F32(pos), F32(vel)]);
    agB = target(AW, AH, [F32(pos), F32(vel)]);
    trailA = target(atlasW, atlasH, [RG16(gl.LINEAR)], levels);
    trailB = target(atlasW, atlasH, [RG16(gl.LINEAR)], levels);
    occ = target(atlasW, atlasH, [RG16(gl.NEAREST)]);
    [trailA, trailB, occ].forEach(clearTarget);
    mipmaps(trailA); mipmaps(trailB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.bindBuffer(gl.ARRAY_BUFFER, bufIds);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(count), gl.STATIC_DRAW);

    frame = 0; simTime = 0; acc = 0;
    built = key();
  }

  function key() {
    return [Math.round(canvas.clientWidth / 40), Math.round(canvas.clientHeight / 90), state.fill, state.warm,
            state.restart || 0].join('|');
  }

  /* Four blur layers (1, 1/2, 1/4, 1/8 of the canvas), then a pyramid of all the light
     from 1/2 down to a few texels: glow at 1/4, sky near 24 texels wide */
  function buildScreen() {
    var w = canvas.width, h = canvas.height;
    var k = w + 'x' + h;
    if (k === screenKey) return;
    screenKey = k;
    layers.forEach(drop); down.forEach(drop); up.forEach(drop); drop(soft);
    layers = []; down = []; up = [];
    for (var i = 0; i < 4; i++) {
      layers.push(target(Math.max(1, Math.round(w / (1 << i))), Math.max(1, Math.round(h / (1 << i))), [F16(gl.LINEAR)]));
    }
    var lw = layers[1].w, lh = layers[1].h;
    soft = target(lw, lh, [F16(gl.LINEAR)]);
    down.push(target(lw, lh, [F16(gl.LINEAR)]));
    up.push(null);
    while (lh > 6 && down.length < 9) {
      lw = Math.max(1, Math.round(lw / 2)); lh = Math.max(1, Math.round(lh / 2));
      down.push(target(lw, lh, [F16(gl.LINEAR)]));
      up.push(target(lw, lh, [F16(gl.LINEAR)]));
    }
    skyLevel = 1;
    down.forEach(function (lv, i) { if (Math.abs(lv.w - 24) < Math.abs(down[skyLevel].w - 24)) skyLevel = i; });
    skyLevel = Math.min(Math.max(skyLevel, 2), down.length - 2);
  }

  /* The current senses: one regime, or a slow drift through them (one per ~40 s) */
  function regimeAt(t) {
    if (state.regime !== 'drift') return REGIMES[state.regime];
    var p = t / 40, i = Math.floor(p), f = p - i;
    f = f * f * (3 - 2 * f);
    var a = REGIMES[DRIFT[i % DRIFT.length]], b = REGIMES[DRIFT[(i + 1) % DRIFT.length]];
    var out = {};
    Object.keys(a).forEach(function (k) { out[k] = a[k] + (b[k] - a[k]) * f; });
    return out;
  }

  function setGrid(u) {
    gl.uniform3f(u.u_grid, NX, NY, NZ);
    gl.uniform1f(u.u_cols, cols);
    gl.uniform2f(u.u_atlas, atlasW, atlasH);
  }

  function bind(unit, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  function unbind(n) {
    for (var i = 0; i < n; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); }
  }

  /* rest camera: where the page sees the volume (css px focal length) */
  function restEye() { return [NX / 2, NY / 2, -camD]; }
  function focalCss() { return 0.5 * canvas.clientHeight / tanH; }

  /* ─────────────────────────────────────────────────────────
     One simulation step
  ───────────────────────────────────────────────────────── */
  function step() {
    var R = regimeAt(simTime);
    moveCells(R);
    markCells(R);
    diffuseTrail(R);
    frame++;
    simTime += 1 / RATE;
  }

  /* cells sense, lean, fall, glide */
  function moveCells(R) {
    var W = canvas.clientWidth, H = canvas.clientHeight;
    var e = restEye(), F = focalCss();
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, agB.fbo);
    gl.viewport(0, 0, AW, AH);
    gl.useProgram(P.step);
    bind(0, agA.tex[0], U.step.u_pos);
    bind(1, agA.tex[1], U.step.u_vel);
    bind(2, trailA.tex[0], U.step.u_trail);
    bind(3, occ.tex[0], U.step.u_occ);
    setGrid(U.step);
    gl.uniform1f(U.step.u_frame, frame);
    gl.uniform1f(U.step.u_sa, R.sa * D2R);
    gl.uniform1f(U.step.u_so, R.so);
    gl.uniform1f(U.step.u_speed, state.speed / RATE * boost);
    gl.uniform1f(U.step.u_turn, Math.min(0.9, R.turn * Math.sqrt(boost)));
    gl.uniform1f(U.step.u_sharp, R.sharp);
    gl.uniform1f(U.step.u_gravity, state.gravity);
    gl.uniform1f(U.step.u_gLod, state.gLod);
    gl.uniform1f(U.step.u_gReach, state.gReach);
    gl.uniform1f(U.step.u_drag, state.drag);
    gl.uniform1f(U.step.u_cross, state.cross);
    gl.uniform1f(U.step.u_gCross, state.gCross);
    gl.uniform1f(U.step.u_warmReach, state.warmReach);
    /* the projects are sources in the focal plane */
    var src = new Float32Array(20), srcK = new Float32Array(5);
    if (state.sources) {
      var Ds = camD + 0.45 * NZ;
      blobs.forEach(function (b, k) {
        var sx = b.left + b.width / 2, sy = b.top + b.height / 2;
        src[k * 4] = e[0] + (sx - W / 2) * Ds / F;
        src[k * 4 + 1] = e[1] - (sy - H / 2) * Ds / F;
        src[k * 4 + 2] = e[2] + Ds;
        src[k * 4 + 3] = Math.max(2, b.height * 0.55 * Ds / F);
        srcK[k] = state.food * (1 + 2 * hover[k]);
      });
    }
    gl.uniform4fv(U.step.u_src, src);
    gl.uniform1fv(U.step.u_srcK, srcK);
    gl.uniform4f(U.step.u_cam, e[0], e[1], e[2], F);
    gl.uniform2f(U.step.u_view, W, H);
    gl.uniform4f(U.step.u_block, veilCss[0], veilCss[1], veilCss[2], veilCss[3]);
    gl.uniform1f(U.step.u_blockK, state.avoid ? state.blockK : 0);
    /* the cursor's well sits in the focal plane, under the pointer */
    var Dw = focus || camD + 0.6 * NZ;
    gl.uniform4f(U.step.u_well, e[0] + (mouse.x - W / 2) * Dw / F, e[1] - (mouse.y - H / 2) * Dw / F, e[2] + Dw,
                 state.cursor ? state.well * mouse.k : 0);
    gl.uniform1f(U.step.u_wellR, state.wellR);
    gl.bindVertexArray(vaoTri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    unbind(4);
    var sw = agA; agA = agB; agB = sw;
  }

  /* where the cells stand (next step's exclusion), and what they leave */
  function markCells(R) {
    clearTarget(occ);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.mark);
    bind(0, agA.tex[0], U.mark.u_pos);
    bind(1, agA.tex[1], U.mark.u_vel);
    setGrid(U.mark);
    gl.uniform1i(U.mark.u_aw, AW);
    gl.uniform1f(U.mark.u_deposit, R.deposit);
    gl.bindVertexArray(vaoCells);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.BLEND);
    unbind(2);
  }

  /* the trail diffuses, evaporates, takes the deposit; its mipmaps are the mass gravity
     reads and the cloud that gives the films their thickness */
  function diffuseTrail(R) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, trailB.fbo);
    gl.viewport(0, 0, atlasW, atlasH);
    gl.useProgram(P.diffuse);
    bind(0, trailA.tex[0], U.diffuse.u_trail);
    bind(1, occ.tex[0], U.diffuse.u_occ);
    setGrid(U.diffuse);
    gl.uniform1f(U.diffuse.u_decay, R.decay);
    gl.uniform1f(U.diffuse.u_diffuse, R.diffuse);
    gl.uniform1f(U.diffuse.u_voids, state.voids);
    gl.uniform1f(U.diffuse.u_frame, frame);
    gl.bindVertexArray(vaoTri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    unbind(2);
    var st = trailA; trailA = trailB; trailB = st;
    mipmaps(trailA);
  }

  /* ─────────────────────────────────────────────────────────
     Camera: a slow breath around the focal plane, plus the cursor
  ───────────────────────────────────────────────────────── */
  function camera(t) {
    var e = restEye();
    if (state.drift && !reduced) {
      e[0] += 3.2 * Math.sin(t * 0.061);
      e[1] += 2.2 * Math.sin(t * 0.047 + 1.3);
      e[2] += 2.5 * Math.sin(t * 0.033 + 0.6);
    }
    if (state.parallax) { e[0] += par.x * 6; e[1] -= par.y * 4; }
    lookAt(view, e, [NX / 2, NY / 2, 0.6 * NZ]);
    var aspect = canvas.width / Math.max(canvas.height, 1);
    perspective(proj, tanH, aspect, 1, camD + NZ + 60);
    focus = camD + 0.6 * NZ + (state.focusDrift && !reduced ? 0.2 * NZ * Math.sin(t * 0.07) : 0);
  }

  /* ─────────────────────────────────────────────────────────
     Render loop
  ───────────────────────────────────────────────────────── */
  function render(now) {
    raf = 0;
    if (!enabled || state.mode === 0 || state.freeze) return;
    if (!init()) { toggle.hidden = true; return; }

    var dt = lastNow ? Math.min(now - lastNow, 250) : 16;
    if (lastNow) {
      frameAcc += dt; frames++;
      if (frames === 90) {
        if (frameAcc / frames > 40 && quality > 0.6) quality *= 0.85;
        frames = 0; frameAcc = 0;
      }
    }
    lastNow = now;
    var ease = function (tau) { return 1 - Math.exp(-dt / 1000 / tau); };

    resize();
    measureLayout();
    if (built !== key()) {
      build();
      /* reduced motion: let the network form off-screen, then show it still */
      preRoll(reduced ? PRE * 3 : PRE);
    }

    for (var i = 0; i < 5; i++) hover[i] += (hoverTarget[i] - hover[i]) * ease(0.3);
    mouse.k += (mouse.kt - mouse.k) * ease(0.3);
    par.x += (par.tx - par.x) * ease(1.2);
    par.y += (par.ty - par.y) * ease(1.2);

    /* steady pace whatever the frame rate: RATE steps per second, at most 3 per frame */
    if (!state.paused && !reduced) {
      acc += dt / 1000 * RATE;
      for (var k = 0; k < 3 && acc >= 1; k++) { step(); acc -= 1; }
      acc = Math.min(acc, 1);
    }
    display(now);

    if (!shown) {
      shown = true;
      document.documentElement.classList.add('profondeur-on');
    }
    if (!reduced) raf = requestAnimationFrame(render);
  }

  /* open on a network already forming: a few steps, sped up so that the cells have
     travelled some forty grid cells */
  function preRoll(n) {
    boost = Math.min(24, Math.max(4, 40 / (state.speed / RATE * n)));
    for (var i = 0; i < n; i++) step();
    boost = 1;
  }

  function display(now) {
    buildScreen();
    var t = (now - startAt) / 1000;
    camera(t);
    var w = canvas.width, h = canvas.height, s = w / Math.max(canvas.clientWidth, 1);
    var coc = 26 * state.dof * s;

    /* 1. every cell through the lens, each blur into its layer */
    gl.useProgram(P.points);
    bind(0, agA.tex[0], U.points.u_pos);
    bind(1, agB.tex[0], U.points.u_prev);
    bind(2, agA.tex[1], U.points.u_vel);
    bind(3, trailA.tex[0], U.points.u_trail);
    setGrid(U.points);
    gl.uniform1i(U.points.u_aw, AW);
    gl.uniformMatrix4fv(U.points.u_viewM, false, view);
    gl.uniformMatrix4fv(U.points.u_projM, false, proj);
    gl.uniform1f(U.points.u_alpha, state.paused || reduced ? 1 : acc);
    gl.uniform1f(U.points.u_focus, focus);
    gl.uniform1f(U.points.u_coc, coc);
    gl.uniform1f(U.points.u_dpr, s);
    gl.uniform1f(U.points.u_maxPoint, MAX_POINT);
    gl.uniform1f(U.points.u_gain, state.gain);
    gl.uniform1f(U.points.u_densK, state.densK);
    gl.uniform1f(U.points.u_bokeh, state.bokeh);
    gl.uniform1f(U.points.u_time, t);
    gl.uniform1f(U.points.u_iri, state.iri);
    gl.uniform1f(U.points.u_cloudK, state.cloudK);
    gl.bindVertexArray(vaoCells);
    /* the widest blur in the volume: layers it does not reach stay empty */
    var widest = coc * Math.max((focus - camD + 4) / Math.max(camD - 4, 1), (camD + NZ + 4 - focus) / (camD + NZ + 4));
    layers.forEach(function (lv, k) {
      clearTarget(lv);
      if (k > 0 && widest < (1 << k)) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(U.points.u_layer, k);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disable(gl.BLEND);
    });
    unbind(4);

    /* 2. all the light at half resolution, then wider and wider */
    gl.bindVertexArray(vaoTri);
    gl.bindFramebuffer(gl.FRAMEBUFFER, down[0].fbo);
    gl.viewport(0, 0, down[0].w, down[0].h);
    gl.useProgram(P.merge);
    bind(0, layers[0].tex[0], U.merge.u_l0);
    bind(1, layers[1].tex[0], U.merge.u_l1);
    bind(2, layers[2].tex[0], U.merge.u_l2);
    bind(3, layers[3].tex[0], U.merge.u_l3);
    gl.uniform2f(U.merge.u_dst, down[0].w, down[0].h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    unbind(4);
    gl.useProgram(P.down);
    for (var j = 1; j < down.length; j++) {
      var src = down[j - 1], lvd = down[j];
      gl.bindFramebuffer(gl.FRAMEBUFFER, lvd.fbo);
      gl.viewport(0, 0, lvd.w, lvd.h);
      bind(0, src.tex[0], U.down.u_src);
      gl.uniform2f(U.down.u_texel, 1 / src.w, 1 / src.h);
      gl.uniform2f(U.down.u_dst, lvd.w, lvd.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(P.up);
    var coarse = down[down.length - 1];
    for (var k = down.length - 2; k >= 1; k--) {
      var lv = up[k];
      gl.bindFramebuffer(gl.FRAMEBUFFER, lv.fbo);
      gl.viewport(0, 0, lv.w, lv.h);
      bind(0, coarse.tex[0], U.up.u_coarse);
      bind(1, down[k].tex[0], U.up.u_fine);
      gl.uniform2f(U.up.u_texel, 1 / coarse.w, 1 / coarse.h);
      gl.uniform2f(U.up.u_dst, lv.w, lv.h);
      gl.uniform1f(U.up.u_keep, 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      coarse = lv;
    }
    unbind(2);

    /* 3. the soft light (wide layers, glow, sky) at half resolution; on reading pages,
       the haze under the copy: the level whose texels are nearest to state.haze css px */
    var cssW = canvas.clientWidth, hz = 2;
    for (var q = 3; q <= down.length - 2; q++) {
      if (Math.abs(cssW / up[q].w - state.haze) < Math.abs(cssW / up[hz].w - state.haze)) hz = q;
    }
    hz = Math.min(hz, down.length - 2);
    copyInView();
    gl.bindFramebuffer(gl.FRAMEBUFFER, soft.fbo);
    gl.viewport(0, 0, soft.w, soft.h);
    gl.useProgram(P.soft);
    bind(0, layers[1].tex[0], U.soft.u_l1);
    bind(1, layers[2].tex[0], U.soft.u_l2);
    bind(2, layers[3].tex[0], U.soft.u_l3);
    bind(3, up[1].tex[0], U.soft.u_glow);
    bind(4, up[skyLevel].tex[0], U.soft.u_sky);
    bind(5, up[hz].tex[0], U.soft.u_haze);
    gl.uniform2f(U.soft.u_dst, soft.w, soft.h);
    gl.uniform2f(U.soft.u_r2, layers[2].w, layers[2].h);
    gl.uniform2f(U.soft.u_r3, layers[3].w, layers[3].h);
    gl.uniform2f(U.soft.u_skyRes, up[skyLevel].w, up[skyLevel].h);
    gl.uniform2f(U.soft.u_hazeRes, up[hz].w, up[hz].h);
    gl.uniform1f(U.soft.u_glowK, 1.4 * state.glow);
    gl.uniform1f(U.soft.u_skyK, 3.0 * state.sky);
    gl.uniform1f(U.soft.u_split, state.split);
    gl.uniform4fv(U.soft.u_text, textBoxes);
    gl.uniform1i(U.soft.u_textN, textN);
    gl.uniform2f(U.soft.u_css, cssW, canvas.clientHeight);
    gl.uniform1f(U.soft.u_read, state.read);
    gl.uniform1f(U.soft.u_readReach, state.readReach);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    unbind(6);

    /* 4. night + soft light + the sharp grains */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(P.compose);
    bind(0, layers[0].tex[0], U.compose.u_l0);
    bind(1, soft.tex[0], U.compose.u_soft);
    gl.uniform2f(U.compose.u_res, w, h);
    /* the light comes up in the first second and a half; a still frame (reduced motion) shows it whole */
    gl.uniform1f(U.compose.u_amount, state.amount * (reduced ? 1 : Math.min(1, (now - startAt) / 1500)));
    gl.uniform1f(U.compose.u_fringe, state.fringe);
    gl.uniform1f(U.compose.u_dpr, s);
    gl.uniform1f(U.compose.u_readDim, state.readDim);
    var H = canvas.clientHeight;
    var veilBox = function (loc, b) {
      if (state.veil) gl.uniform4f(loc, b[0] * s, (H - b[3]) * s, b[2] * s, (H - b[1]) * s);
      else gl.uniform4f(loc, -1e5, -1e5, -1e5, -1e5);
    };
    /* where the haze follows the copy, it replaces the veil of the header */
    veilBox(U.compose.u_veil, reading() ? [-1e5, -1e5, -1e5, -1e5] : veilCss);
    veilBox(U.compose.u_veil2, footCss);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    unbind(2);
  }

  function kick() {
    if (!raf && enabled && state.mode !== 0) raf = requestAnimationFrame(render);
  }

  window.addEventListener('resize', kick);

  /* ─────────────────────────────────────────────────────────
     The button: particles, or the original gradient
  ───────────────────────────────────────────────────────── */
  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pg-particles';
  /* a few grains of light, sharp and out of focus, as in the background itself */
  toggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">' +
    '<circle cx="10.4" cy="10.4" r="3.8" opacity=".35"/><circle cx="4.6" cy="5" r="2" opacity=".6"/>' +
    '<circle cx="12.2" cy="3.6" r="1.15"/><circle cx="3.8" cy="12.3" r="1.1"/><circle cx="7.5" cy="8.2" r=".8"/></svg>';
  /* the icon never changes: its name says what a click will do */
  function label() {
    var name = enabled ? 'Turn particles off' : 'Turn particles on';
    toggle.setAttribute('aria-label', name);
    toggle.title = name;
  }
  label();
  document.body.appendChild(toggle);

  function setEnabled(on) {
    enabled = on;
    label();
    try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch (e) { /* not remembered */ }
    if (on) {
      lastNow = 0;
      kick();
    } else {
      cancelAnimationFrame(raf); raf = 0;
      shown = false;
      /* the canvas fades out and the CSS gradient starts moving again */
      document.documentElement.classList.remove('profondeur-on');
    }
  }
  toggle.addEventListener('click', function () { setEnabled(!enabled); });

  /* keep it clear of the footer when the footer comes into view */
  var footer = document.querySelector('.section-footer'), placing = 0;
  function place() {
    placing = 0;
    var b = 16;
    if (footer) {
      var over = innerHeight - footer.getBoundingClientRect().top;
      if (over > 0) b = Math.min(innerHeight - 60, Math.max(16, over + 10));
    }
    toggle.style.bottom = b + 'px';
  }
  function schedule() { if (!placing) placing = requestAnimationFrame(place); }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  /* the footer moves when the page settles: images, fonts */
  window.addEventListener('load', schedule);
  if (window.ResizeObserver) new ResizeObserver(schedule).observe(document.body);
  place();

  kick();

  /* ─────────────────────────────────────────────────────────
     Helpers + lab API
  ───────────────────────────────────────────────────────── */
  /* view matrix: screen right = +x, screen up = +y, depth grows into the page (+z) */
  function lookAt(m, e, c) {
    var f = norm([c[0] - e[0], c[1] - e[1], c[2] - e[2]]);
    var r = norm(cross([0, 1, 0], f));
    var u = cross(f, r);
    m[0] = r[0]; m[1] = u[0]; m[2] = -f[0]; m[3] = 0;
    m[4] = r[1]; m[5] = u[1]; m[6] = -f[1]; m[7] = 0;
    m[8] = r[2]; m[9] = u[2]; m[10] = -f[2]; m[11] = 0;
    m[12] = -dot(r, e); m[13] = -dot(u, e); m[14] = dot(f, e); m[15] = 1;
  }

  function perspective(m, tanHalf, aspect, near, far) {
    var f = 1 / tanHalf;
    m.fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = 2 * far * near / (near - far);
  }

  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm(a) { var l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function uniforms(p, names) {
    var out = {};
    names.forEach(function (n) { out[n] = gl.getUniformLocation(p, n); });
    return out;
  }

  function createShader(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(vs, fs) {
    var v = createShader(gl.VERTEX_SHADER, vs);
    var f = createShader(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    var p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  /* small API, for the tuning lab */
  window.ProfondeurBG = {
    set: function (opts) {
      Object.keys(opts).forEach(function (k) { state[k] = opts[k]; });
      document.documentElement.classList.toggle('profondeur-on', enabled && state.mode !== 0 && (shown || !!state.freeze));
      kick();
    },
    restart: function () { state.restart = (state.restart || 0) + 1; kick(); },
    /* lab: try a set of senses live — becomes the 'custom' regime */
    tune: function (params) {
      REGIMES.custom = Object.assign({}, REGIMES.custom || REGIMES[state.regime] || REGIMES.cells, params);
      state.regime = 'custom';
      kick();
      return REGIMES.custom;
    },
    /* lab: one display frame without stepping */
    show: function () { if (!init()) return; resize(); measureLayout(); display(performance.now()); },
    /* run n steps at once (lab: see the network form without waiting) */
    advance: function (n) {
      if (!init()) return;
      resize(); measureLayout();
      if (built !== key()) build();
      for (var i = 0; i < n; i++) step();
      display(performance.now());
    },
    /* lab: GPU time of n steps and of one frame (the reads force the queue to finish) */
    bench: function (n) {
      if (!init()) return null;
      var px = new Float32Array(4);
      var sync = function () {
        gl.bindFramebuffer(gl.FRAMEBUFFER, trailA.fbo);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      };
      sync();
      var t0 = performance.now();
      for (var i = 0; i < n; i++) step();
      sync();
      var t1 = performance.now();
      for (i = 0; i < 10; i++) display(performance.now());
      sync();
      var t2 = performance.now();
      return { stepMs: +((t1 - t0) / n).toFixed(3), frameMs: +((t2 - t1) / 10).toFixed(3) };
    },
    /* lab: put the pointer somewhere at once (for advance() tests) */
    pointer: function (x, y) { mouse.x = x; mouse.y = y; mouse.k = mouse.kt = 1; },
    get: function () {
      return Object.assign({ quality: quality, frame: frame, agentsCount: count, grid: [NX, NY, NZ],
                             calm: calm, enabled: enabled, focus: focus }, state);
    }
  };
})();
