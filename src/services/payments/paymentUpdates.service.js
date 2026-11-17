'use strict';
const {RegistrationError}=require('../registration/errors');

// Checkout notices contain no payment data; subscription streams push committed snapshots.
// shortcut: process-local delivery; add shared pub/sub before running multiple API workers.
class PaymentUpdates {
    constructor(){this.listeners=new Map();this.total=0;}
    publish(business,snapshot){for(const listener of this.listeners.get(business)||[])listener(snapshot);}
    open(req,res,{business,expiresAt,authorize,snapshot:readSnapshot}) {
        const subscription=typeof readSnapshot==='function';
        const listeners=this.listeners.get(business)||new Set();
        if(listeners.size>=4||this.total>=200)throw new RegistrationError('BILLING_UNAVAILABLE',503);
        const duration=subscription?expiresAt-Date.now():Math.min(60000,expiresAt-Date.now());
        if(!(duration>0))throw new RegistrationError('AUTH_REQUIRED',401);
        let closed=false,checking=false,queued=false,queuedSnapshot;
        const cleanup=()=>{
            if(closed)return;closed=true;clearTimeout(timeout);clearInterval(heartbeat);
            listeners.delete(update);this.total--;if(!listeners.size)this.listeners.delete(business);
        };
        const end=()=>{if(closed)return;res.write('event: settled\ndata: {}\n\n');cleanup();res.end();};
        const update=async snapshot=>{
            if(closed)return;
            if(checking){queued=true;queuedSnapshot=snapshot;return;}
            checking=true;
            try {
                await authorize();
                if(subscription) {
                    const current=snapshot||await readSnapshot();
                    if(!closed)res.write(current?'id: '+current.revision+'\nevent: snapshot\ndata: '+JSON.stringify(current)+'\n\n':'event: ready\ndata: {}\n\n');
                }else if(!closed)res.write('event: updated\ndata: {}\n\n');
            }
            catch(_){end();}
            finally{checking=false;if(queued&&!closed){const next=queuedSnapshot;queued=false;queuedSnapshot=undefined;update(next);}}
        };
        res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
        res.flushHeaders();
        listeners.add(update);this.listeners.set(business,listeners);this.total++;
        const heartbeat=setInterval(()=>{if(!closed)res.write(': keepalive\n\n');},15000);
        const timeout=setTimeout(end,duration);
        res.once('close',cleanup);req.once('aborted',cleanup);
        update();
        return end;
    }
}
const paymentUpdates=new PaymentUpdates();
module.exports={PaymentUpdates,paymentUpdates};
