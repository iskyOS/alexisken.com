# Personal Website

This is my personal website. Blown up and rebuilt September 2019.

## Components

I utilized the [Navbar](https://getbootstrap.com/docs/4.0/components/navbar/) component from [Bootstrap](https://getbootstrap.com) for this site. 

Other than that, the rest of the site is basic HTML+CSS, created by me.

### The jelly

The home page has a wobbly strawberry jelly you can poke and drag. It's rendered with
[three.js](https://threejs.org) using the WebGPU renderer (`three/webgpu` + TSL), which
falls back to WebGL 2 in browsers without WebGPU.

- `assets/js/jelly-physics.js` – the soft-body simulation and mesh generation. No three.js
  dependency, so it can be tested in Node.
- `assets/js/jelly.js` – the scene: renderer, lights, translucent material, and pointer
  interaction (click to poke, press-and-drag to pull).

three.js is loaded from a CDN through the import map in `index.html`; if the browser can't
run it, the jelly's section quietly collapses and the rest of the page is unaffected.

## License
[MIT](https://choosealicense.com/licenses/mit/)