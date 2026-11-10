import { expect, it } from 'vitest';
import { combinedWindPage } from '../../functions/api/wind-timeline.js';
const row=(h,id=h)=>({id,device_id:'A',recorded_at:`2026-11-01T${String(h).padStart(2,'0')}:00:00+05:30`,wind_angle:0,wind_direction:'N'});
const page=(p,o,offset=0,limit=50,start=null,end=null)=>combinedWindPage(async(table,off,size)=>{const rows=table==='wind_data'?p:o;if(rows instanceof Error)throw rows;return rows.slice(off,off+size)},'',start,end,offset,limit,'*');
it('primary wins per hour and fallback fills only gaps',async()=>{
 const p=await page([row(12),row(10)],[13,12,11,10,9].map(h=>row(h)));
 expect(p.rows.map(r=>[r.id,r.source])).toEqual([[13,'wind_operation_logs'],[12,'wind_data'],[11,'wind_operation_logs'],[10,'wind_data'],[9,'wind_operation_logs']]);
});
it('preserves distinct primary timestamps, deduplicates both sources',async()=>{
 const a=row(10),b={...a,id:20,recorded_at:'2026-11-01T10:30:00+05:30'};
 expect((await page([b,a,a],[a,row(9),row(9)])).rows.map(r=>r.id)).toEqual([20,10,9]);
});
it('handles primary empty, both empty, nulls and sensor-failure operations honestly',async()=>{
 expect((await page([],[])).rows).toEqual([]);
 const bad={...row(10),wind_angle:null,wind_direction:'-'};
 const p=await page([null,bad],[{...bad,status:'SENSOR_NO_DATA'}]);
 expect(p.rows[0]).toMatchObject({source:'wind_operation_logs',record_kind:'operation',wind_angle:null});
});
it('respects range and merged pagination',async()=>{
 const p=await page([13,12,11,10,9].map(h=>row(h)),[],1,1,new Date('2026-11-01T10:00:00+05:30'),new Date('2026-11-01T13:00:00+05:30'));
 expect(p.rows[0].id).toBe(11);expect(p.has_more).toBe(true);
});
it('degrades safely on either source failure',async()=>{
 const p=await page(new Error('private secret'),[row(9)]); expect(p.partial).toBe(true);expect(p.rows[0].priority_unverified).toBe(true);expect(p.warning).not.toContain('private');
 expect((await page([row(10)],new Error('private'))).rows[0].source).toBe('wind_data');
 expect((await page(new Error(),new Error())).partial).toBe(true);
});
