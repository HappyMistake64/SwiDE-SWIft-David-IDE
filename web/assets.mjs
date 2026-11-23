// Create the universal image sets accepted by the Pocket project generator.
const catalog = "Resources/Assets.xcassets/";
const info = {version:1, author:"Xcode Pocket"};
export function addImage(project, name, mime, encoded) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(name)) throw Error("Název musí začínat písmenem nebo podtržítkem a mít nejvýše 80 znaků.");
  const suffix = {"image/png":"png", "image/jpeg":"jpg"}[mime];
  if (!suffix) throw Error("Vyber PNG nebo JPEG.");
  const prefix = catalog + name + ".imageset/";
  if ([...Object.keys(project.files),...Object.keys(project.binaries || {})].some(p=>p.toLowerCase().startsWith(prefix.toLowerCase()))) throw Error("Tento imageset už existuje.");
  const filename = name + "." + suffix;
  return {...project,version:3,files:{...project.files,
    [catalog+"Contents.json"]:project.files[catalog+"Contents.json"] || JSON.stringify({info}),
    [prefix+"Contents.json"]:JSON.stringify({images:[{idiom:"universal",scale:"1x",filename}],info})
  },binaries:{...project.binaries,[prefix+filename]:{mime,base64:encoded}}};
}
function mount() {
  const picker=document.querySelector("#asset-file"), status=document.querySelector("#asset-message");
  if (!picker) return;
  function refresh() {
    const list=document.querySelector("#asset-list");
    list.replaceChildren();
    for (const [path,asset] of Object.entries(window.pocketIDE.getProject().binaries || {})) {
      const row=document.createElement("li"), img=document.createElement("img");
      img.alt="";img.width=36;img.height=36;img.style.objectFit="contain";img.loading="lazy";
      img.src="data:"+asset.mime+";base64,"+asset.base64;
      row.append(img,document.createTextNode(" "+path.replace(catalog,"")));list.append(row);
    }
  }
  picker.onchange=async()=>{
    const file=picker.files[0]; if (!file) return;
    try {
      if (file.size > 3000000) throw Error("Obrázek překračuje limit Pocket projektu.");
      const name=prompt("Název obrázku pro SwiftUI Image(…)",file.name.replace(/\.[^.]+$/,""));
      if (!name) return;
      const bytes=new Uint8Array(await file.arrayBuffer()); let raw="";
      for(let n=0;n<bytes.length;n+=8192) raw+=String.fromCharCode(...bytes.subarray(n,n+8192));
      const api=window.pocketIDE;api.save();
      api.commitProject(addImage(api.getProject(),name,file.type,btoa(raw)),api.getActive());
      status.textContent='Obrázek přidán. Ve SwiftUI použij Image("'+name+'").';
    } catch(error) {status.textContent=error.message;}
    finally {picker.value="";}
  };
  window.addEventListener("pocket-render",refresh);refresh();
}
if(typeof document!=="undefined") mount();
