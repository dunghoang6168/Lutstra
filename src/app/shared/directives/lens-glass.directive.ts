import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { lensMapPixels } from './lens-map';

/** Only Ambient in Electron (Chromium) gets lenses; the browser preview and reduced transparency keep the blur. */
const ACTIVE = "html[data-layout='liquid-glass'][data-runtime='desktop']";
const PLAIN = '(prefers-reduced-transparency: reduce), (forced-colors: active)';
const SVG_NS = 'http://www.w3.org/2000/svg';
let nextFilter = 0;
// ponytail: unbounded, but keys are a handful of block sizes per window width; add an LRU if resizing ever bloats it.
const mapUrls = new Map<string, string>();

function mapUrl(width: number, height: number, radius: number, bezel: number): string {
  const key = `${width}x${height}r${radius}b${bezel}`;
  let url = mapUrls.get(key);
  if (!url) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.putImageData(new ImageData(lensMapPixels(width, height, radius, bezel) as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
    url = canvas.toDataURL('image/png');
    mapUrls.set(key, url);
  }
  return url;
}

function defs(): SVGSVGElement {
  let svg = document.getElementById('lens-defs') as SVGSVGElement | null;
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'lens-defs';
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    document.body.append(svg);
  }
  return svg;
}

/**
 * Liquid glass for Ambient's floating controls: an SVG filter that blurs what lies behind the host and bends it
 * at the rim (feDisplacementMap with a map from lensMapPixels). The directive keeps one filter per host sized to
 * it and sets `.lens-on` plus `--lens-filter`; the tint and the backdrop-filter itself are in _themes.scss.
 * Tuned by --lens-bezel, --lens-refract, --lens-blur and --lens-saturate.
 */
@Directive({ selector: '[appLensGlass]', standalone: true })
export class LensGlassDirective {
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    let filter: SVGFilterElement | null = null;
    let built = '';

    const clear = () => {
      filter?.remove();
      filter = null;
      built = '';
      host.classList.remove('lens-on');
      host.style.removeProperty('--lens-filter');
    };

    afterNextRender(() => {
      const plain = matchMedia(PLAIN);
      const apply = () => {
        const box = host.getBoundingClientRect();
        const width = Math.round(box.width), height = Math.round(box.height);
        if (!document.documentElement.matches(ACTIVE) || plain.matches || !width || !height) return clear();
        const style = getComputedStyle(host);
        const read = (name: string, fallback: number) => parseFloat(style.getPropertyValue(name)) || fallback;
        const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, width / 2, height / 2);
        const bezel = read('--lens-bezel', 22), refract = read('--lens-refract', 44);
        const blur = read('--lens-blur', 6), saturate = read('--lens-saturate', 1.6);
        const key = [width, height, radius, bezel, refract, blur, saturate].join();
        if (key === built) return;
        built = key;
        // A fresh id per build: Chromium may keep painting a cached backdrop for a filter edited in place.
        const id = `lens-${nextFilter++}`;
        const next = document.createElementNS(SVG_NS, 'filter');
        next.id = id;
        for (const [name, value] of Object.entries({ x: 0, y: 0, width, height, filterUnits: 'userSpaceOnUse',
          primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) next.setAttribute(name, String(value));
        next.innerHTML = `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" edgeMode="duplicate" result="b"/>
          <feImage href="${mapUrl(width, height, radius, bezel)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none" result="m"/>
          <feDisplacementMap in="b" in2="m" scale="${refract}" xChannelSelector="R" yChannelSelector="G" result="d"/>
          <feColorMatrix in="d" type="saturate" values="${saturate}"/>`;
        defs().append(next);
        filter?.remove();
        filter = next;
        host.style.setProperty('--lens-filter', `url(#${id})`);
        host.classList.add('lens-on');
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      // The first size applies at once; drags of the window settle before the map is rebuilt.
      const resized = () => { clearTimeout(timer); timer = setTimeout(apply, built ? 100 : 0); };
      const sizes = new ResizeObserver(resized);
      sizes.observe(host);
      const modes = new MutationObserver(apply);
      modes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-layout', 'data-runtime'] });
      plain.addEventListener('change', apply);
      destroyRef.onDestroy(() => {
        clearTimeout(timer);
        sizes.disconnect();
        modes.disconnect();
        plain.removeEventListener('change', apply);
        clear();
      });
    });
  }
}
