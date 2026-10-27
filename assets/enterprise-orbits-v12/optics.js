/* Linear-light scene rendering and a restrained optical glow for real geometry. */
window.MTWHologramOptics=(()=>{
  function create(renderer){
    const T=THREE,options={type:T.HalfFloatType,minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:false};
    const source=new T.WebGLRenderTarget(1,1,{...options,depthBuffer:true,samples:4}),a=new T.WebGLRenderTarget(1,1,options),b=new T.WebGLRenderTarget(1,1,options);
    const camera=new T.OrthographicCamera(-1,1,1,-1,0,1),scene=new T.Scene(),plane=new T.Mesh(new T.PlaneGeometry(2,2));scene.add(plane);
    const vertex='varying vec2 uvScreen;void main(){uvScreen=uv;gl_Position=vec4(position.xy,0.,1.);}';
    const extract=new T.ShaderMaterial({vertexShader:vertex,fragmentShader:'uniform sampler2D source;varying vec2 uvScreen;void main(){vec3 c=texture2D(source,uvScreen).rgb;float peak=max(c.r,max(c.g,c.b));gl_FragColor=vec4(c*smoothstep(.7,1.8,peak),1.);}',uniforms:{source:{value:source.texture}},depthTest:false,depthWrite:false,toneMapped:false});
    const blur=new T.ShaderMaterial({vertexShader:vertex,fragmentShader:'uniform sampler2D source;uniform vec2 stepSize;varying vec2 uvScreen;void main(){vec3 c=texture2D(source,uvScreen).rgb*.227027;c+=(texture2D(source,uvScreen+stepSize*1.384615).rgb+texture2D(source,uvScreen-stepSize*1.384615).rgb)*.316216;c+=(texture2D(source,uvScreen+stepSize*3.230769).rgb+texture2D(source,uvScreen-stepSize*3.230769).rgb)*.070270;gl_FragColor=vec4(c,1.);}',uniforms:{source:{value:a.texture},stepSize:{value:new T.Vector2()}},depthTest:false,depthWrite:false,toneMapped:false});
    const combine=new T.ShaderMaterial({vertexShader:vertex,fragmentShader:'uniform sampler2D source;uniform sampler2D glow;varying vec2 uvScreen;void main(){vec3 c=texture2D(source,uvScreen).rgb+texture2D(glow,uvScreen).rgb*.26;gl_FragColor=vec4(c,1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',uniforms:{source:{value:source.texture},glow:{value:a.texture}},depthTest:false,depthWrite:false});
    let width=0,height=0;
    function pass(material,target){plane.material=material;renderer.setRenderTarget(target);renderer.render(scene,camera);}
    function render(world,view){
      const size=renderer.getDrawingBufferSize(new T.Vector2()),w=size.x,h=size.y;
      if(w!==width||h!==height){width=w;height=h;source.setSize(w,h);a.setSize(Math.max(1,w>>1),Math.max(1,h>>1));b.setSize(Math.max(1,w>>1),Math.max(1,h>>1));}
      const prior=renderer.toneMapping;renderer.toneMapping=T.NoToneMapping;renderer.setRenderTarget(source);renderer.render(world,view);pass(extract,a);
      blur.uniforms.source.value=a.texture;blur.uniforms.stepSize.value.set(1/a.width,0);pass(blur,b);blur.uniforms.source.value=b.texture;blur.uniforms.stepSize.value.set(0,1/a.height);pass(blur,a);
      renderer.toneMapping=T.AgXToneMapping;pass(combine,null);renderer.toneMapping=prior;
    }
    function dispose(){source.dispose();a.dispose();b.dispose();extract.dispose();blur.dispose();combine.dispose();plane.geometry.dispose();}
    return {render,dispose};
  }
  return {create};
})();
