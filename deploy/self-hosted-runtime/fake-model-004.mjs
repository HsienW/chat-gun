import http from 'node:http';
import {randomUUID} from 'node:crypto';
// 只供 V5 資源測試：不保存請求標頭／內容，不評估模型語意。
let calls=0;
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ready',calls}));return;}
  if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
  let body='';for await(const part of req){body+=part;if(body.length>2*1024*1024){res.writeHead(413);res.end();return;}}
  let input;try{input=JSON.parse(body);}catch{res.writeHead(400);res.end();return;}
  calls++;const id=`chatcmpl-spike-${randomUUID()}`,created=Math.floor(Date.now()/1000),model=input.model;
  const content='V5 本機假模型資源測試回覆；此輸出不作模型語意驗收。';
  const usage={prompt_tokens:16,completion_tokens:16,total_tokens:32};
  if(input.stream){res.writeHead(200,{'content-type':'text/event-stream'});
    for(const row of [{choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage}])res.write(`data: ${JSON.stringify({id,created,model,object:'chat.completion.chunk',...row})}\n\n`);
    res.end('data: [DONE]\n\n');
  }else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,created,model,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage}));}
});
server.listen(Number(process.env.PORT||8080),'0.0.0.0');
process.on('SIGTERM',()=>server.close());
