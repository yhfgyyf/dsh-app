import type { Session, WebContents } from 'electron';
import { isEndpointDocument } from '../shared/config.ts';

/** Only the app-owned conversation document can use the microphone. */
export function installDesktopPermissions(ses: Session, getContents: () => WebContents | undefined, getEndpoint: () => string) {
  const trusted = (contents: WebContents | null) => !!contents && contents === getContents() &&
    !contents.isDestroyed() && isEndpointDocument(contents.getURL(), getEndpoint());
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mainDocument = trusted(contents) && details.isMainFrame && isEndpointDocument(details.requestingUrl, getEndpoint());
    const audioOnly = permission === 'media' && 'mediaTypes' in details &&
      details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio';
    callback(mainDocument && (permission === 'clipboard-sanitized-write' || audioOnly));
  });
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!trusted(contents) || !isEndpointDocument(origin, getEndpoint()) || !details.isMainFrame ||
        !details.requestingUrl || !isEndpointDocument(details.requestingUrl, getEndpoint())) return false;
    return permission === 'clipboard-sanitized-write' || permission === 'media' && details.mediaType === 'audio';
  });
}
