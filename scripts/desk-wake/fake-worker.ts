export function fakeWorker(wake: boolean, respondToAudio = true): Worker {
  const source = `let epoch=0; let count=0; let woke=false; onmessage=({data})=>{
    if(data.type==='init')postMessage({type:'ready'});
    if(data.type==='reset'){epoch=data.epoch;count=0;}
    if(data.type==='audio'&&${respondToAudio}){
      count+=data.samples.length;
      if(${wake}&&!woke&&count>data.rate*0.9){
        woke=true;
        const event={type:'wake',through:data.through,epoch,startFrame:Math.floor(data.rate*0.3)};
        postMessage(event);postMessage(event);
      }
      postMessage({type:'processed',through:data.through,epoch});
    }
  }`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return worker;
}
