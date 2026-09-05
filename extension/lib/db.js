let connection;
export function openDB() {
  if (!connection) connection = new Promise((resolve,reject) => {
    const request = indexedDB.open('aistudio-bookflow', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('groups', { keyPath: 'id' });
      request.result.createObjectStore('assets', { keyPath: 'id' });
      request.result.createObjectStore('meta', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}
async function operation(store, mode, action) {
  const db = await openDB();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(store, mode);
    let result;
    const request = action(tx.objectStore(store));
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('本地保存失败，请检查浏览器可用空间。'));
  });
}
export const get = (store,id) => operation(store,'readonly',s => s.get(id));
export const all = store => operation(store,'readonly',s => s.getAll());
export const put = (store,value) => operation(store,'readwrite',s => s.put(value));
export const remove = (store,id) => operation(store,'readwrite',s => s.delete(id));
export async function assetToWire(id) {
  const asset = await get('assets',id);
  if (!asset) throw new Error('图片文件在本地已不存在，请重新添加。');
  const bytes = new Uint8Array(await asset.blob.arrayBuffer());
  let binary = '';
  for (let start=0; start<bytes.length; start+=32768) binary += String.fromCharCode(...bytes.subarray(start,start+32768));
  return { id, name: asset.name, type: asset.type, base64: btoa(binary) };
}
