/** Inspector previews: color swatches, images, links, readable dates, decoded JWTs and JSON inside strings. */

import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { TypeName } from '../../../core/data/tree';
import { Icon } from '../../components/icons';
import { copy, host } from '../../store';
import { hexToRgba, relativeTime, rgbToHsl, valueHints, type ValueHint } from '../../values';

export function ValuePreview({ type, value, valueKey }: { type: TypeName; value: string; valueKey: string | number | null }) {
  const hints = useMemo(() => valueHints(type, value, valueKey), [type, value, valueKey]);
  if (!hints.length) return null;
  return (
    <div class="panel-section">
      <p class="section-title">Preview</p>
      <div class="pv">
        {hints.map((h, i) => (
          <Hint key={i} h={h} />
        ))}
      </div>
    </div>
  );
}

function Hint({ h }: { h: ValueHint }) {
  switch (h.kind) {
    case 'color':
      return <ColorHint css={h.css} />;
    case 'image':
      return <ImageHint url={h.url} />;
    case 'link':
      return (
        <a class="pv-link" href={h.url} onClick={(e) => (e.preventDefault(), openLink(h.url))} title={h.url}>
          <Icon name="external" /> Open link
        </a>
      );
    case 'email':
      return (
        <a class="pv-link" href={`mailto:${h.address}`} onClick={(e) => (e.preventDefault(), openLink(`mailto:${h.address}`))}>
          <Icon name="external" /> Write to {h.address}
        </a>
      );
    case 'date':
      return <DateHint ms={h.ms} from={h.from} />;
    case 'jwt':
      return <JwtHint header={h.header} payload={h.payload} />;
    case 'json':
      return <JsonHint value={h.value} />;
  }
}

function openLink(url: string): void {
  void host().request('openExternal', { url }).catch(() => window.open(url, '_blank', 'noopener'));
}

function ColorHint({ css }: { css: string }) {
  const rgba = hexToRgba(css);
  const rows: [string, string][] = [['CSS', css]];
  if (rgba) {
    const [r, g, b, a] = rgba;
    const [h, s, l] = rgbToHsl(r, g, b);
    rows.push(a < 1 ? ['RGBA', `rgba(${r}, ${g}, ${b}, ${a})`] : ['RGB', `rgb(${r}, ${g}, ${b})`]);
    rows.push(a < 1 ? ['HSLA', `hsla(${h}, ${s}%, ${l}%, ${a})`] : ['HSL', `hsl(${h}, ${s}%, ${l}%)`]);
  }
  return (
    <div class="pv-color">
      <i class="pv-swatch" style={{ background: css }} />
      <dl class="kv">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd class="copyable" title="Copy" onClick={() => copy(v, `Copied ${v}`)}>
              {v}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function ImageHint({ url }: { url: string }) {
  const [state, setState] = useState<{ w: number; h: number } | 'error' | null>(null);
  if (state === 'error') return <span class="pv-note">The image could not be loaded.</span>;
  return (
    <figure class="pv-image">
      <img
        src={url}
        alt=""
        referrerpolicy="no-referrer"
        onLoad={(e) => setState({ w: (e.target as HTMLImageElement).naturalWidth, h: (e.target as HTMLImageElement).naturalHeight })}
        onError={() => setState('error')}
      />
      {state && <figcaption>{`${state.w} × ${state.h}`}</figcaption>}
    </figure>
  );
}

function DateHint({ ms, from }: { ms: number; from: 'iso' | 'seconds' | 'millis' }) {
  const d = new Date(ms);
  return (
    <dl class="kv">
      {from !== 'iso' && (
        <>
          <dt>Read as</dt>
          <dd>Unix time ({from})</dd>
        </>
      )}
      <dt>Local</dt>
      <dd>{d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })}</dd>
      <dt>UTC</dt>
      <dd>{d.toISOString()}</dd>
      <dt>Relative</dt>
      <dd>{relativeTime(ms)}</dd>
    </dl>
  );
}

const TIME_CLAIMS: Record<string, string> = { exp: 'Expires', iat: 'Issued', nbf: 'Not before', auth_time: 'Authenticated' };

function JwtHint({ header, payload }: { header: Record<string, unknown>; payload: Record<string, unknown> }) {
  const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  const nbf = typeof payload.nbf === 'number' ? payload.nbf * 1000 : null;
  const now = Date.now();
  const status = exp !== null && exp < now ? ['danger', `Expired ${relativeTime(exp)}`] : nbf !== null && nbf > now ? ['warn', `Not valid until ${relativeTime(nbf)}`] : exp !== null ? ['ok', `Valid, expires ${relativeTime(exp)}`] : null;
  return (
    <div class="pv-jwt">
      <div class="pv-row">
        <span class="pill">JWT · {String(header.alg ?? '?')}</span>
        {status && <span class={`pill ${status[0]}`}>{status[1]}</span>}
      </div>
      <dl class="kv">
        {Object.entries(payload).map(([k, v]) => (
          <Fragment key={k}>
            <dt title={TIME_CLAIMS[k]}>{k}</dt>
            <dd>{TIME_CLAIMS[k] && typeof v === 'number' ? `${new Date(v * 1000).toISOString()} (${relativeTime(v * 1000)})` : typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </Fragment>
        ))}
      </dl>
      <span class="pv-note">Decoded only: the signature is not verified.</span>
    </div>
  );
}

function JsonHint({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  return (
    <div>
      <div class="pv-row">
        <span class="pv-note">This string contains JSON.</span>
        <span class="spacer" />
        <button class="btn" onClick={() => copy(text, 'JSON copied')}>
          <Icon name="copy" /> Copy formatted
        </button>
      </div>
      <pre class="code-block">{text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text}</pre>
    </div>
  );
}
