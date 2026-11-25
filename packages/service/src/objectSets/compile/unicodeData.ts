export interface UnicodeTables {
  readonly byLowerCase: ReadonlyMap<string, readonly string[]>;
  readonly separator: string;
  readonly notLetter: string;
  readonly digit: string;
}

const SEPARATOR_RANGES =
  '1:11,2:5,2,b:6,r:3,2,r:1a,2:9,2:3,2:4,o,w,cr:3,d:d,6:6,2,2:g,3a,9,6:1,2,33,3w,60:5,16:1,3:2,1b,2,3,3' +
  ',19:1,c:f,c:4,23:3,2v,9:1,b,k:1,2:d,2,6f:3,5:1,1d:e,w,16,8:1,29,3m:1,b,3m:9,2,3d,3e:1,3j,2:5,3d:a,3h' +
  ':8,5,5n,9:6,i:9,3f,23,g,b:1,4m:m,3:5,b:a,2,2,2:3,20,1l:7,2:5,2:c,34:5,27:1,2k,h1:s,k:9,2v,h9:1,i,r:1' +
  ',27:5,1x:1,4e:2,2:3,l:9,7:a,4,8i,4:1,45,4:x,v:1,3l:6,2:5,4h:1,b:g,a:b,3h:3,1o:4,1r:1,1t:7,c,kq,2:2,c' +
  ':2,e:2,e:2,e:1,2:o,2:22,2:a,4:a,2:e,i:x,1r:1,2:3,2:1,b,2:2,6:5,2,2,2,5,c:1,5:4,6:3,2:1f,3:6,5:ih,n:a' +
  ',m:1eb,3:3t,6e:5,f:6,35,40:1a,2:19,z:p,2:2g,d:5x,r:k,3:y,7,6:4,3:2,2k:1,2n,45:f,x:11,a,h:u,2:db,535:' +
  '1r,h3l:1i,1k:1,7i:2,2s,b,2w:9,3:5,9:m,a:1,2w:1,4e:3,5:9,1n:3,2f:1,15:2,2,1e:1,1c,2q:c,h:1,3h:3,o:2,2' +
  't:1,h:1,2y,f:1,3k,aad:4xr,fe,3t:w,a4:h,1t:1,1j:7,19:3,h:9,n:y,2:i,2:3,44,2:e,b:6,r:5,r:a,3f:6,2:6,b:' +
  '4,77:2,5:18,4:2f,2:c,4,1c:18,6d:q,11:3,u,9,2d,1d:5,be,ko:8,o:8,14:8,24:4,n:5,4,w,3h:1,3:f,3:19,1t:8,' +
  '8:8,11:2,u:2,15,z:b,1v:6,p:7,p:7,q:3,d:6,97:5,33,w:1,5t:u,1b,z:8,1x:9,17:8,19:3,1o:6,3g:6,5:j,2e:6,c' +
  ',37:3,1d:1,28:3,5,e,2:2,2:j,1w:5,30,8b:1,2:1,37:4,b:1,2,2x,6z:m,2y:2,t:c,25,3l:5,70,4v:8,2a:2,4c,2l:' +
  '7,2c:2,2:4,2m:9,60,2o:4,l:i,4:1,hy:1,23:c,35:1d,e,sh:32,2:4,29p:1,u6:f,apb:1,3q,1u:8,5:1,m:6,ek:2,7l' +
  ':q,94,i:2,f52,3:4,319:6n,b:2,4:c3,7:m,g:g,2o:37,1p:6t,b:12,3:1n,6:2,7:7,9:1,8:t,5:1o,m:1t,4,3f:j,d:j' +
  ',d:2e,a:o,nd,q,w,q,w,q,w,q,w,q,1p:e7,1k:3,1f:7,2:d,2:6,1c4,c0,lc,js:8,3z:1,lu:1v,25:1o,c3:1,7j:17,5:' +
  '2r,d:e,3:e,2:e,2:10,b:4t,1l:s,e:17,5:8,8:1,f:5,4b:rc,4:g,4:c,4:61,7:b,5,g:b,5:1j,9:9,7:13,9:t,3:b,5:' +
  '1,f:8,14:9j,9:d,3:c,4:a,4:1k,2,5:f,3:b,5:9,8:42,2:2j,b,gvlz,v:2n,1egx:1ekd,3:1ekd';

const NOT_LETTER_RANGES =
  '1:1r,r:5,r:1a,2:9,2:3,2:4,o,w,cr:3,d:d,6:6,2,2:g,3a,9,6:1,2,33,3w,60:5,16:1,3:2,1b,2,3,3,19:1,c:f,c:' +
  '4,1t:d,2v,9:1,b,7:9,4:1,2:d,2,4x:9,19:3,5:1,1d:e,w,16,8:1,29,3m:c,3a:9,3:9,2,2x:9,7,34:b,39:a,2:5,33' +
  ':k,30:9,8:8,5,2q:9,2o,9:6,8:j,31:9,5,23,g:c,39:9,14:m,3:q,2,2,2:3,20,1l:7,2:5,2:c,2u:f,1t:9,5:1,2k,h' +
  '1:s,k:9,2v,h9:1,i,r:1,27:5,1x:1,4e:2,2:3,5:9,7:9,7:a,4,2:9,87,4:b,3l:a,4:x,v:1,2p:9,7:9,7:6,2:5,4h:s' +
  ',a:b,1d:9,1v:3,1o:e,7:9,11:1,1t:7,c,kq,2:2,c:2,e:2,e:2,e:1,2:2s,2:a,4:a,2:e,i:x,1r:1,2:3,2:1,b,2:2,6' +
  ':5,2,2,2,5,c:1,5:4,6:3,2:1f,3:6,5:ih,n:a,m:1eb,3:3t,6e:5,f:6,35,40:1a,2:19,z:p,2:2g,d:5x,r:k,3:y,7,6' +
  ':4,3:2,2k:1,4:2n,41:f,x:11,a:1b,2:lpb,wh:1i,1k:1,7i:2,h:9,22,b,2w:9,3:5,9:m,a:1,2w:1,4e:3,5:9,1n:3,2' +
  'f:b,v:2,2,4:9,11:1,1c,2q:c,3:9,5:1,h:9,2f:9,3:3,o:2,2t:1,h:1,2y,f:1,3k,5:9,a9z:5bz,16,3t:w,a4:h,1t:1' +
  ',1j:7,19:3,h:9,n:y,2:i,2:3,44,2:v,r:5,r:1w,1t:6,2:6,b:4,77:2,5:18,4:2f,2:c,4,1c:18,6d:q,11:3,u,9,2d,' +
  '1d:5,5n:9,5i,ko:8,o:8,14:8,24:4,n:5,4,w,3h:1,3:f,3:19,1t:8,8:8,11:2,u:2,15,z:b,1v:6,p:7,p:7,q:3,d:6,' +
  '97:5,1d:9,7:9,11,w:1,5t:u,1b,z:8,1x:9,17:8,19:3,1o:6,3g:6,5:t,24:6,c,z:9,1p:d,1d:1,28:3,5,3:9,2,2:2,' +
  '2:j,1w:5,30,1z:9,63:1,2:1,37:g,2,2x,a:9,6g:m,2y:2,d:9,7:c,25,7:9,7:j,25:f,70,4l:i,2a:2,a:9,3t,2l:7,2' +
  'c:2,2:4,2m:9,60,f:9,20:4,b:s,4:1,67:9,1z:9,1j:9,7i:1,23:m,2v:1d,e,sh:32,2:4,29p:1,u6:f,8vl:9,1t3:9,5' +
  ':1,29:9,18,1u:8,5:1,b:9,2:6,ek:c,7b:q,94,i:2,f52,3:4,319:70,4:c3,7:m,g:g,2o:37,1p:6t,b:12,3:1n,6:2,7' +
  ':7,9:1,8:t,5:1o,m:1t,4,3f:j,d:j,d:2e,a:o,nd,q,w,q,w,q,w,q,w,q,b:fl,1k:3,1f:7,2:d,2:6,1bp:9,6,bl:9,6,' +
  'dt:9,6w:9,5,js:8,3l:9,5:1,lu:1v,25:1o,c3:1,7j:17,5:2r,d:e,3:e,2:e,2:10,b:4t,1l:s,e:17,5:8,8:1,f:5,4b' +
  ':rc,4:g,4:c,4:61,7:b,5,g:b,5:1j,9:9,7:13,9:t,3:b,5:1,f:8,14:9j,9:d,3:c,4:a,4:1k,2,5:f,3:b,5:9,8:42,2' +
  ':2u,sm:2t4v,e1oi,v:2n,1egx:1ekd,3:1ekd';

const DIGIT_RANGES =
  '1c:9,17r:9,3r:9,5j:9,bh:9,3b:9,3b:9,3b:9,3b:9,3b:9,3b:9,3b:9,3b:9,3b:9,2p:9,3b:9,1z:9,7r:9,1z:9,1fr:' +
  '9,13:9,8d:9,3l:9,4n:9,7:9,53:9,2f:9,3r:9,7:9,r7r:9,iv:9,13:9,5j:9,n:9,2f:9,bb:9,gev:9,13b:9,1on:9,7:' +
  '9,m5:9,3l:9,1p:9,41:9,7r:9,9j:9,3b:9,af:9,2v:9,7:j,25:9,br:9,2v:9,if:9,2f:9,6v:9,1z:9,1j:9,9z:9,d07:' +
  '9,1t3:9,2f:9,3r:9,ev:9,iuv:9,251:1d,1tt:9,br:9,dz:9,6w:9,nq:9,3o7:9';

const CASE_FOLD_RUNS =
  '2p:-w:8,9:-w:2:2,3:-w:e,36:5vj,1:-w:5,6:-w:h,i:-w:7,7:3d,2:-1:o:2,1e:-1:3:2,7:-1:8:2,h:-1:n:2,1b:-1:' +
  '3:2,6:5f,3:-1:2:2,5:-1,4:-1,6:-1,3:2p,4:-1,1:4j,1:wu9,3:3m,3:-1:3:2,7:-1,5:-1,3:-1,4:-1:2:2,5:-1,4:-' +
  '1,2:1k,f:-1:8:2,f:-27,2:-1:9:2,m:-1,4:-1:k:2,16:-1:9:2,p:-1,3:8cf:2,3:-1,5:-1:5:2,9:8bj,1:8bg,1:8bi,' +
  '1:-5u,1:-5q,2:-5p:2,3:-5m,2:-5n,1:wnj,4:-5p,1:wnf,2:-5r,1:wo7,1:wmg,1:wn8,2:-5t,1:-5v,1:wn8,1:8af,1:' +
  'wn5,3:-5v,2:8al,1:-5x,3:-5y,8:89z,3:-62,2:wn7,1:-62,4:wmi,1:-62,1:-1x,1:-61:2,2:-1z,6:-63,b:wlx,1:wl' +
  'u,5v:-1:2:2,6:-1,4:3m:3,1d:-12,1:-11:3,4:-w:7,8:-w:9,a:-w:6,7:-w:2,2:-1s,1:-1r:2,a:-8,2:-1:c:2,p:7,1' +
  ':-38,5:-1,3:-1,1h:-w:w,w:-28:g,h:-1:h:2,16:-1:r:2,1j:-1:7:2,d:-f,2:-1:1c:2,40:-1c:12,29b:2bk:17,19:2' +
  'bk:3,l7:-8:6,1oy:-1,6n:r9g,4:2xy,h:raw,37:-1:23:2,4g:-1:1c:2,2n:8:8,g:8:6,g:8:8,g:8:8,g:8:6,h:8:4:2,' +
  'f:8:8,g:22:2,2:2e:4,4:2s:2,2:3k:2,2:34:2,2:3i:2,4:8:8,g:8:8,g:8:8,g:8:2,3:9,g:9,d:8:2,g:8:2,5:7,e:9,' +
  '9n:-s,y:-g:g,k:-1,ng:-q:q,1gg:-1c:1c,1d:-1,4:-8bv,1:-8bs,2:-1:3:2,b:-1,3:-1,b:-1:1e:2,2z:-1:2:2,7:-1' +
  ',d:-5ls:12,13:-5ls,6:-5ls,nx0:-1:n:2,1s:-1:e:2,4i:-1:7:2,g:-1:v:2,1z:-1:2:2,5:-1:5:2,d:-1,5:-1:2:2,3' +
  ':1c,3:-1:a:2,u:-1:8:2,j:-1:2:2,5:-1:8:2,15:-1,nx:-ps,t:-tzk:28,gk1:-w:q,yv:-14:14,4w:-14:10,5b:-13:b' +
  ',c:-13:f,g:-13:7,8:-13:2,1dx:-1s:1f,4w:-w:m,28g:-w:w,gww:-w:w,2j:-r:p,o6f:-y:y';

const CASE_FOLD_SPECIAL =
  '2x:2x.21.8g,2z:2z.23.6ju,6d:6d.5h.6jv,cm:cm.ck.cl,cp:cp.cn.co,cs:cs.cq.cr,dv:dv.dt.du,qg:qg.pk.s4,qx' + ':qx.q1.6jq';

function bracketCharacter(point: number): string {
  const character = String.fromCodePoint(point);

  return '[]\\^-'.includes(character) ? `\\${character}` : character;
}

function decodeRanges(encoded: string): string {
  let prev = 0;
  let result = '';

  for (const token of encoded.split(',')) {
    const colon = token.indexOf(':');
    const delta = Number.parseInt(colon === -1 ? token : token.slice(0, colon), 36);
    const length = colon === -1 ? 0 : Number.parseInt(token.slice(colon + 1), 36);
    const first = prev + delta;
    const last = first + length;

    result += first === last ? bracketCharacter(first) : `${bracketCharacter(first)}-${bracketCharacter(last)}`;

    prev = last;
  }

  return result;
}

function decodeCaseFolds(): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  let prevLo = 0;

  for (const token of CASE_FOLD_RUNS.split(',')) {
    const parts = token.split(':');
    const lo = prevLo + Number.parseInt(parts[0] ?? '0', 36);
    const diff = Number.parseInt(parts[1] ?? '0', 36);
    const count = parts[2] === undefined ? 1 : Number.parseInt(parts[2], 36);
    const step = parts[3] === undefined ? 1 : Number.parseInt(parts[3], 36);

    prevLo = lo;

    for (let index = 0; index < count; index += 1) {
      const lowerPoint = lo + index * step;
      const lower = String.fromCodePoint(lowerPoint);

      map.set(lower, [lower, String.fromCodePoint(lowerPoint + diff)]);
    }
  }

  for (const token of CASE_FOLD_SPECIAL.split(',')) {
    const [keyPart, valuesPart] = token.split(':');

    if (keyPart === undefined || valuesPart === undefined) continue;

    const key = String.fromCodePoint(Number.parseInt(keyPart, 36));

    map.set(
      key,
      valuesPart.split('.').map((point) => String.fromCodePoint(Number.parseInt(point, 36))),
    );
  }

  return map;
}

let cached: UnicodeTables | undefined;

export function unicodeTables(): UnicodeTables {
  if (cached) return cached;

  cached = {
    byLowerCase: decodeCaseFolds(),
    separator: decodeRanges(SEPARATOR_RANGES),
    notLetter: decodeRanges(NOT_LETTER_RANGES),
    digit: decodeRanges(DIGIT_RANGES),
  };

  return cached;
}
