/* InventuurAPP+Print 10.8.8: D110_M v4 printing from tested v0.2.1. */
'use strict';
window.InventoryPrinter = (() => {
  const SERVICE = 'e7810a71-73ae-499d-8c15-faa9aef0c3f2';
  const CHAR = 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f';
  const DOTS_PER_MM = 8;
  const KEY = 'inventuur_printer_settings_v1';
  const $ = id => document.getElementById(id);
  let device = null, server = null, characteristic = null, pendingWait = null;
  let busy = false, connecting = false, firstPrintAfterConnect = true, lastError = '', feedback = '';
  let phase = 'unconfigured', statusTimer = null, lastPrintWasTest = false;
  function log(text) {
    const el = $('printerLog');
    if (el) { el.textContent += '[' + new Date().toLocaleTimeString('et-EE') + '] ' + text + '\n'; el.scrollTop = el.scrollHeight; }
    console.log('[Printer] ' + text);
  }
  function saved() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function remembered() { const s = saved(); return s && s.remember && s.deviceId ? s : null; }
  function connected() { return !!(device && device.gatt && device.gatt.connected && characteristic); }
  function article() { return typeof editPart !== 'undefined' && editPart && $('editOverlay').classList.contains('show') ? editPart : null; }
  function basePhase() { return connected() ? 'connected' : (remembered() || device ? 'remembered' : 'unconfigured'); }
  function setPhase(next, text = '') { phase = next; feedback = text; render(); }
  function render() {
    const btn = $('editPrint'), st = $('printerSettingsStatus');
    if (!btn || !st) return;
    const labels = {unconfigured:'Prindi', remembered:'Prindi', connecting:'Ühendan…', connected:'Prindi', printing:'Prindin…', success:'Prinditud', error:'Proovi uuesti'};
    const descriptions = {unconfigured:'Printer pole seadistatud', remembered:'Viimati kasutatud: ' + (remembered()?.deviceName || device?.name || 'Printer') + ' · ühendamata', connecting:'Ühendan printeriga…', connected:'Ühendatud: ' + (device?.name || 'Printer'), printing:'Prindin…', success:'Prinditud', error:'Printeri viga'};
    btn.dataset.printState = phase;
    btn.disabled = !article() || busy || connecting;
    btn.querySelector('.editPrintLabel').textContent = labels[phase];
    btn.title = feedback || descriptions[phase];
    btn.setAttribute('aria-label', (labels[phase] || 'Prindi') + '. ' + (feedback || descriptions[phase]));
    st.dataset.printState = phase;
    st.querySelector('.printerStatusText').textContent = feedback || descriptions[phase];
    $('printerConnect').disabled = busy || connecting || connected();
    $('printerDisconnect').disabled = busy || connecting || !connected();
    const test=$('printerTest');
    test.disabled = busy || connecting;
    test.dataset.printState = phase;
    const testLabels={unconfigured:'Prindi test',remembered:'Prindi test',connecting:'Ühendan…',connected:'Prindi test',printing:'Prindin…',success:'Test prinditud',error:'Proovi uuesti'};
    test.querySelector('.printerTestLabel').textContent=phase==='success'&&!lastPrintWasTest?'Prindi test':testLabels[phase];
    test.title=feedback || descriptions[phase];
    test.setAttribute('aria-label',testLabels[phase]+'. '+(feedback||descriptions[phase]));
    $('printerChoose').disabled = busy || connecting;
  }
  function message(text) { $('printerMessageText').textContent = text; $('printerMessage').hidden = false; }
  function closeMessage() { $('printerMessage').hidden = true; }
  function settingsPage() {
    closeMessage();
    if (article()) closeEditOverlay();
    showPage('export');
    $('printerSection').scrollIntoView({block:'start', behavior:'smooth'});
    $('printerConnect').focus({preventScroll:true});
  }
  function saveSettings() {
    if (!$('printerRemember').checked) { try { localStorage.removeItem(KEY); } catch (_) {} render(); return; }
    const old = saved() || {};
    const selected = $('printerSelect');
    const id = selected.value || device?.id || old.deviceId || '';
    const name = selected.selectedOptions[0]?.textContent || device?.name || old.deviceName || '';
    try { localStorage.setItem(KEY, JSON.stringify({remember:true,deviceId:id,deviceName:name,width:$('labelWidth').value,height:$('labelHeight').value})); }
    catch (e) { log('Seadistuste salvestamine: ' + e.message); }
    render();
  }
  function restoreSettings() {
    const s = saved();
    if (!s) return;
    $('printerRemember').checked = s.remember !== false;
    if (s.width) $('labelWidth').value = s.width;
    if (s.height) $('labelHeight').value = s.height;
    if (s.deviceId) setSelected(s.deviceId, s.deviceName || 'Salvestatud printer');
  }
  function setSelected(id, name) {
    const select = $('printerSelect');
    let opt = [...select.options].find(x => x.value === id);
    if (!opt) { opt = new Option(name || 'Printer', id); select.add(opt); }
    else opt.textContent = name || opt.textContent;
    select.value = id;
  }
  async function refreshDevices() {
    if (typeof navigator.bluetooth?.getDevices !== 'function') return;
    try {
      const permitted = await navigator.bluetooth.getDevices();
      const s = remembered();
      const select = $('printerSelect'), current = select.value || s?.deviceId || '';
      select.replaceChildren(new Option('Vali uus printer…', ''));
      permitted.forEach(d => select.add(new Option(d.name || 'Tundmatu printer', d.id)));
      if (current && permitted.some(d => d.id === current)) select.value = current;
      else if (s?.deviceId) setSelected(s.deviceId, s.deviceName || 'Salvestatud printer');
      else if (device?.id) setSelected(device.id, device.name || 'Printer');
      render();
    } catch (e) { log('Lubatud seadmete lugemine: ' + e.message); }
  }
  function hex(bytes) { return Array.from(bytes).map(x => x.toString(16).padStart(2,'0')).join(' '); }
  function xor(bytes) { let n=0; for (const x of bytes) n ^= x; return n; }
  function packet(cmd, data=[]) { const body=[cmd,data.length,...data]; return new Uint8Array([0x55,0x55,...body,xor(body),0xaa,0xaa]); }
  function connectPacket() { const body=[0xc1,0x01,0x01]; return new Uint8Array([0x03,0x55,0x55,...body,xor(body),0xaa,0xaa]); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve,ms)); }
  function cancelWait() { if (pendingWait) { clearTimeout(pendingWait.timer); pendingWait.resolve(null); pendingWait=null; } }
  function notify(event) {
    const v=event.target.value, bytes=new Uint8Array(v.buffer,v.byteOffset,v.byteLength);
    log('RX: ' + hex(bytes));
    if (bytes.length<6 || bytes[0]!==0x55 || bytes[1]!==0x55) return;
    const cmd=bytes[2], len=bytes[3], data=bytes.slice(4,4+len);
    if (pendingWait && pendingWait.cmd===cmd) { const w=pendingWait; clearTimeout(w.timer); pendingWait=null; w.resolve(data); }
  }
  function waitFor(cmd, timeout=3000) {
    cancelWait();
    return new Promise(resolve => {
      const w={cmd,resolve,timer:null};
      w.timer=setTimeout(() => { if (pendingWait===w) { pendingWait=null; log('Timeout 0x'+cmd.toString(16)); resolve(null); } }, timeout);
      pendingWait=w;
    });
  }
  async function write(bytes) {
    if (!connected()) throw new Error('Printer pole ühendatud');
    if (characteristic.properties.writeWithoutResponse) await characteristic.writeValueWithoutResponse(bytes);
    else await characteristic.writeValue(bytes);
  }
  async function sendAndWait(cmd, data, respCmd, timeout=3000) {
    const response=respCmd!=null ? waitFor(respCmd,timeout) : null;
    try { await write(packet(cmd,data)); } catch(e) { cancelWait(); throw e; }
    return response ? await response : null;
  }
  function onDisconnected() {
    log('GATT ühendus katkes'); cancelWait();
    if (characteristic) characteristic.removeEventListener('characteristicvaluechanged',notify);
    characteristic=null; server=null;
    if (!busy && !connecting) setPhase(basePhase());
    else render();
  }
  async function useDevice(d) {
    device=d;
    d.removeEventListener('gattserverdisconnected',onDisconnected);
    d.addEventListener('gattserverdisconnected',onDisconnected);
    log('Ühendan: '+(d.name||'Printer'));
    server=await d.gatt.connect();
    const service=await server.getPrimaryService(SERVICE);
    characteristic=await service.getCharacteristic(CHAR);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged',notify);
    const response=waitFor(0xc2,3000);
    try { await write(connectPacket()); } catch(e) { cancelWait(); throw e; }
    const resp=await response;
    log(resp ? 'Connect vastus: '+hex(resp) : 'Connect vastust ei tulnud; GATT ühendus olemas');
    firstPrintAfterConnect=true;
    if ($('printerRemember').checked) { setSelected(d.id,d.name||'Printer'); saveSettings(); }
    setPhase('connected');
  }
  // Start the browser chooser immediately from the user's click. Local storage only
  // remembers the name/ID; it cannot recreate a BluetoothDevice after reload.
  function requestSavedPrinterOnClick() {
    const s=remembered();
    if (!s || device || typeof navigator.bluetooth?.getDevices==='function') return null;
    if (typeof navigator.bluetooth?.requestDevice!=='function')
      return Promise.reject(new Error('Web Bluetooth pole selles brauseris saadaval.'));
    const name=String(s.deviceName || '').trim();
    const validName=name && !/^(Vali uus printer|Salvestatud printer|Printer)$/i.test(name);
    const options=validName
      ? {filters:[{name}],optionalServices:[SERVICE,0x1800,0x1801,0x180a,0x180f]}
      : {acceptAllDevices:true,optionalServices:[SERVICE,0x1800,0x1801,0x180a,0x180f]};
    log('Brauser ei toeta getDevices(): avan ' + (validName ? 'salvestatud nimega filtreeritud' : 'tavalise') + ' seadmevalija');
    try { return navigator.bluetooth.requestDevice(options); }
    catch(e) { return Promise.reject(e); }
  }
  async function findRemembered() {
    const s=remembered();
    if (device && (!s || device.id===s.deviceId)) return device;
    if (!s) return null;
    if (typeof navigator.bluetooth?.getDevices !== 'function') throw new Error('Brauser ei toeta salvestatud printeri taastamist. Vali printer uuesti seadetes.');
    const permitted=await navigator.bluetooth.getDevices();
    const match=permitted.find(d => d.id===s.deviceId);
    if (!match) throw new Error('Salvestatud printeri luba puudub. Vali printer uuesti seadetes.');
    return match;
  }
  async function connectRemembered(selectedDevicePromise=null) {
    if (connected()) return true;
    if (connecting) return false;
    connecting=true; setPhase('connecting');
    try {
      const d=selectedDevicePromise ? await selectedDevicePromise : await findRemembered();
      if (!d) throw new Error('Printerit pole seadistatud.');
      await useDevice(d);
      return true;
    } catch(e) {
      lastError=e.message; log('Ühenduse viga: '+lastError);
      if (device?.gatt?.connected) device.gatt.disconnect();
      characteristic=null; server=null;
      setPhase('error',lastError);
      return false;
    } finally { connecting=false; render(); }
  }
  // requestDevice is called directly in the button handler, before any await.
  async function chooseNewPrinter() {
    if (busy || connecting) return;
    if (!navigator.bluetooth?.requestDevice) { setPhase('error','Web Bluetooth pole saadaval. Ava rakendus toetatud brauseris HTTPS-i kaudu.'); return; }
    let selected;
    try { selected=navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[SERVICE,0x1800,0x1801,0x180a,0x180f]}); }
    catch(e) { setPhase('error',e.message); return; }
    connecting=true; setPhase('connecting','Vali Bluetoothi seadmete hulgast printer…');
    try {
      const d=await selected;
      setSelected(d.id,d.name||'Printer');
      if ($('printerRemember').checked) saveSettings();
      await useDevice(d);
      await refreshDevices();
    } catch(e) {
      lastError=e.message; log('Printeri valimine/ühendamine: '+lastError);
      if (device?.gatt?.connected) device.gatt.disconnect();
      characteristic=null; server=null;
      setPhase('error',lastError);
    } finally { connecting=false; render(); }
  }
  async function connectFromSettings(selectedDevicePromise=null) {
    if (busy || connecting || connected()) return;
    if ($('printerSelect').value || remembered() || device) {
      // Explicit selection may differ from the remembered printer.
      const selected=$('printerSelect').value;
      if (selectedDevicePromise) await connectRemembered(selectedDevicePromise);
      else if (selected && selected!==device?.id && typeof navigator.bluetooth?.getDevices==='function') {
        connecting=true; setPhase('connecting');
        try {
          const list=await navigator.bluetooth.getDevices();
          const d=list.find(x=>x.id===selected);
          if (!d) throw new Error('Printeri luba puudub. Kasuta nuppu „Vali teine printer“.');
          await useDevice(d);
        } catch(e) { lastError=e.message; log(lastError); setPhase('error',lastError); }
        finally { connecting=false; render(); }
      } else await connectRemembered();
    } else await chooseNewPrinter();
  }
  async function disconnect() {
    if (busy || connecting) return;
    cancelWait();
    if (characteristic) {
      characteristic.removeEventListener('characteristicvaluechanged',notify);
      try { await characteristic.stopNotifications(); } catch(e) { log('Notifications: '+e.message); }
    }
    if (device?.gatt?.connected) device.gatt.disconnect();
    characteristic=null; server=null;
    log('Ühendus katkestatud'); setPhase(basePhase());
  }
  function size() {
    const widthMm=Number($('labelWidth').value),heightMm=Number($('labelHeight').value);
    if (!Number.isFinite(widthMm)||widthMm<10||widthMm>100||!Number.isFinite(heightMm)||heightMm<8||heightMm>15)
      throw new Error('Kontrolli mõõte: laius 8–15 mm, pikkus 10–100 mm');
    return {widthMm,heightMm};
  }
  function shortenArticleName(text) {
    const value=String(text??''),maxLength=35,suffixLength=10;
    return value.length<=maxLength ? value : value.slice(0,maxLength-3-suffixLength)+'...'+value.slice(-suffixLength);
  }
  function buildLabelBitmap(articleNo,articleName,widthMm,heightMm) {
    if (!String(articleNo).trim()) throw new Error('Sisesta artikli number');
    if (typeof JsBarcode!=='function') throw new Error('JsBarcode ei laaditud');
    const longPx=Math.ceil(Math.round(widthMm*DOTS_PER_MM)/8)*8;
    const shortPx=Math.ceil(Math.round(heightMm*DOTS_PER_MM)/8)*8;
    const canvas=document.createElement('canvas');
    canvas.width=longPx;canvas.height=shortPx;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,longPx,shortPx);
    ctx.fillStyle='#000';ctx.textAlign='center';ctx.textBaseline='top';
    const edgeX=8,edgeY=6,gap=2;
    const nameFont=Math.max(12,Math.round(shortPx*0.20));
    const numFont=Math.max(19,Math.round(shortPx*0.34)+1);
    const barcodeRowGap=6;
    const numberTop=shortPx-edgeY-numFont+8;
    const barcodeTop=edgeY+nameFont+gap;
    const barcodeHeight=numberTop-barcodeRowGap-barcodeTop;
    if (barcodeHeight<14) throw new Error('Etikett on kolme rea jaoks liiga kitsas');
    const bc=document.createElement('canvas');
    JsBarcode(bc,String(articleNo),{format:'CODE128',width:1,height:barcodeHeight,displayValue:false,margin:0});
    const modules=bc.width;
    const moduleScale=(longPx-2*edgeX)/(modules+12);
    if (moduleScale<1) throw new Error('Artiklinumber on selle etiketi jaoks liiga pikk: turvatsoon ei mahu');
    const quietZone=Math.ceil(2*moduleScale);
    const barcodeWidth=longPx-2*edgeX-2*quietZone;
    const barcodeLeft=edgeX+quietZone;
    if (barcodeWidth/modules<1) throw new Error('Triipkood ei mahu etiketile');
    ctx.font='bold '+nameFont+'px Arial';
    ctx.fillText(shortenArticleName(articleName),longPx/2,edgeY,longPx-2*edgeX);
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(bc,0,0,bc.width,bc.height,barcodeLeft,barcodeTop,barcodeWidth,barcodeHeight);
    ctx.font='bold '+numFont+'px Arial';
    ctx.fillText(String(articleNo),longPx/2,numberTop,longPx-2*edgeX);
    const physical=document.createElement('canvas');
    physical.width=shortPx;physical.height=longPx;
    const pc=physical.getContext('2d');
    pc.fillStyle='#fff';pc.fillRect(0,0,shortPx,longPx);
    pc.translate(shortPx,0);pc.rotate(Math.PI/2);pc.drawImage(canvas,0,0);
    const pixels=pc.getImageData(0,0,physical.width,physical.height).data,rows=[];
    for(let y=0;y<physical.height;y++) {
      const bytes=new Uint8Array(physical.width/8);
      for(let x=0;x<physical.width;x++) {
        const i=(y*physical.width+x)*4;
        if (pixels[i+3]>10&&(pixels[i]+pixels[i+1]+pixels[i+2])/3<128) bytes[x>>3]|=0x80>>(x&7);
      }
      rows.push(bytes);
    }
    return {rows,widthPx:physical.width,heightPx:physical.height};
  }
  async function printLabel(articleNo,articleName) {
    if (busy || connecting) return false;
    if (!connected()) throw new Error('Printer pole ühendatud');
    busy=true; setPhase('printing');
    try {
      const {widthMm,heightMm}=size();
      const {rows,widthPx,heightPx}=buildLabelBitmap(articleNo,articleName,widthMm,heightMm);
      log('D110_M v4 landscape '+heightMm+' × '+widthMm+' mm; bitmap '+widthPx+' × '+heightPx+' px');
      if (firstPrintAfterConnect) {
        const warm=await sendAndWait(0xa3,[1],0xb3,1500);
        log('Soojendusstaatus: '+(warm?hex(warm):'vastust ei saadud'));
        firstPrintAfterConnect=false;
      }
      await sendAndWait(0x21,[3],0x31);
      await sendAndWait(0x23,[1],0x33);
      await sendAndWait(0x01,[0,1,0,0,0,0,0,3,0],0x02);
      const pageSizeData=[(heightPx>>8)&255,heightPx&255,(widthPx>>8)&255,widthPx&255,0,1,0,0,0,0,0,0,0];
      await sendAndWait(0x13,pageSizeData,0x14);
      for(let r=0;r<rows.length;r++) {
        if (!connected()) throw new Error('BT ühendus katkes printimise ajal');
        const row=rows[r],hi=(r>>8)&255,lo=r&255;
        if (row.every(b=>b===0)) await write(packet(0x84,[hi,lo,1]));
        else {
          let totalBlack=0;
          for(const byte of row) { let b=byte; while(b) { totalBlack+=b&1;b>>=1; } }
          await write(packet(0x85,[hi,lo,0,totalBlack&255,(totalBlack>>8)&255,1,...row]));
        }
        await sleep(4);
      }
      await sendAndWait(0xe3,[1],0xe4);
      let finished=false;
      for(let i=0;i<30&&!finished;i++) {
        const data=await sendAndWait(0xa3,[1],0xb3,1500);
        if (data&&data.length>=2&&((data[0]<<8)|data[1])>=1) finished=true;
        if (!finished) await sleep(300);
      }
      await sendAndWait(0xf3,[1],0xf4);
      log(finished?'Printimine kinnitatud':'Käsud saadetud; valmimist ei kinnitatud');
      setPhase(finished?'success':'connected',finished?'Prinditud':'Käsud saadetud; kontrolli printerit');
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer=setTimeout(()=>{ if (!busy) setPhase(basePhase()); },3000);
      return finished;
    } catch(e) { lastError=e.message; log('PRINT ERROR: '+lastError); setPhase('error',lastError); throw e; }
    finally { busy=false; render(); }
  }
  async function printArticle(selectedDevicePromise=null) {
    const part=article();
    if (!part || busy || connecting) return;
    closeMessage();
    if (!connected() && !remembered() && !device) {
      setPhase('unconfigured');
      message('Printer pole seadistatud. Vali ja ühenda printer lehel Andmed → 5. Printer.');
      return;
    }
    if (!connected()) {
      const ok=await connectRemembered(selectedDevicePromise);
      if (!ok) { message('Printeriga ei õnnestunud ühendust luua. '+lastError+' Ava printeri seaded või proovi uuesti.'); return; }
    }
    // Capture article before any async operation, so closing the modal cannot switch the target.
    try { lastPrintWasTest=false; await printLabel(part,names[part]||'Nimetus puudub'); }
    catch(e) { message('Printimine ebaõnnestus: '+e.message); }
  }
  async function printTest(selectedDevicePromise=null) {
    closeMessage();
    if(!connected()) {
      if(!remembered()&&!device&&!$('printerSelect').value) {
        await chooseNewPrinter();
        if(!connected()) { if(phase!=='error')message('Printerit ei valitud. Vali Bluetoothi printer ja proovi uuesti.'); return; }
      } else {
        await connectFromSettings(selectedDevicePromise);
        if(!connected()) { message('Printeriga ei õnnestunud ühendust luua. '+(lastError||'Vali printer uuesti.') );return; }
      }
    }
    try { lastPrintWasTest=true; await printLabel('1234567890123','Printeri test'); }
    catch(e) { message('Testprint ebaõnnestus: '+e.message); }
  }
  function onEditOpen() { if (!busy && !connecting) setPhase(basePhase()); else render(); }
  function onEditClose() { render(); }
  function init() {
    restoreSettings();
    setPhase(basePhase());
    refreshDevices();
    $('editPrint').addEventListener('click', e=>{e.preventDefault();e.stopPropagation();
      const selection=!connected() && !busy && !connecting && article() ? requestSavedPrinterOnClick() : null;
      printArticle(selection);
    });
    $('printerConnect').addEventListener('click', ()=>{
      if (busy || connecting || connected()) return;
      const selection=requestSavedPrinterOnClick();
      connectFromSettings(selection);
    });
    $('printerChoose').addEventListener('click', chooseNewPrinter);
    $('printerDisconnect').addEventListener('click', disconnect);
    $('printerTest').addEventListener('click',()=>{
      if(busy||connecting)return;
      // Request the chooser synchronously while the click has user activation.
      const selection=!connected()&&remembered()?requestSavedPrinterOnClick():null;
      printTest(selection);
    });
    $('printerMessageClose').addEventListener('click',closeMessage);
    $('printerMessageSettings').addEventListener('click',settingsPage);
    $('printerMessage').addEventListener('click',e=>{if(e.target===$('printerMessage'))closeMessage();});
    ['labelWidth','labelHeight','printerRemember','printerSelect'].forEach(id=>$(id).addEventListener('change',()=>{saveSettings();if(!busy&&!connecting)setPhase(basePhase());}));
    log('D110_M v4 printerimoodul valmis · Web Bluetooth: '+(navigator.bluetooth?'JAH':'EI')+' · turvaline kontekst: '+(window.isSecureContext?'JAH':'EI'));
  }
  init();
  return {onEditOpen,onEditClose,connected};
})();
