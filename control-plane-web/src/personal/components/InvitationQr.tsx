import {useEffect,useState} from 'react';
import QRCode from 'qrcode';

export const invitationQrFits=(text:string):boolean=>new TextEncoder().encode(text).length<=2953;
export function InvitationQr({invitation}:{invitation:string}) {
  const [image,setImage]=useState('');
  const [failed,setFailed]=useState(false);
  useEffect(()=>{let active=true;setImage('');setFailed(false);
    if(invitationQrFits(invitation)) void QRCode.toDataURL([{data:new TextEncoder().encode(invitation),mode:'byte'}],{errorCorrectionLevel:'L',margin:4,width:720})
      .then(value=>{if(active)setImage(value);}).catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;};
  },[invitation]);
  if(!invitationQrFits(invitation)||failed)return <p>完整邀请超出当前二维码容量或暂不能编码，请使用下方完整邀请粘贴；证书不会被截断。</p>;
  return image?<img src={image} alt="本次完整手机配对邀请二维码" style={{width:'min(100%, 480px)',height:'auto',imageRendering:'pixelated',background:'#fff'}}/>:<p>正在生成本次完整邀请二维码…</p>;
}
