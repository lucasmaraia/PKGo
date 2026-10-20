// app-media:// serves cover art and icons to the renderer straight from memory:
//   app-media://icon/<library id>, app-media://pic/<library id>,
//   app-media://console-icon/<title id>
import {protocol} from 'electron';
import type {AppCore} from '@core/AppCore';

const SCHEME = 'app-media';

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{scheme: SCHEME, privileges: {standard: true, secure: true}}]);
}

export function registerMediaProtocol(core: AppCore): void {
  protocol.handle(SCHEME, request => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\//, '');
    const image =
      url.hostname === 'icon'
        ? core.icon(id)
        : url.hostname === 'pic'
          ? core.pic(id)
          : url.hostname === 'console-icon'
            ? core.consoleIcon(id)
            : null;
    if (!image) return new Response(null, {status: 404});
    return new Response(new Uint8Array(image), {
      headers: {'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600'},
    });
  });
}
