<script setup>
import {ref,watch,onMounted,onBeforeUnmount} from 'vue';
import {useGlobalState} from '../store';
const {openSettings,isDark}=useGlobalState();
const props=defineProps({action:{type:String,default:'signup'}});
const token=defineModel('value');
const container=ref(null),error=ref('');let widget,sequence=0,disposed=false;
async function reset(){
  const run=++sequence;token.value='';error.value='';
  if(widget!==undefined&&window.turnstile){window.turnstile.remove(widget);widget=undefined;}
  if(!openSettings.value.cfTurnstileSiteKey)return;
  for(let i=0;i<100&&!window.turnstile;i++)await new Promise(resolve=>setTimeout(resolve,100));
  if(disposed||run!==sequence||!container.value)return;
  if(!window.turnstile){error.value='验证暂未加载，请点击重试';return;}
  try {widget=window.turnstile.render(container.value,{
    sitekey:openSettings.value.cfTurnstileSiteKey,action:props.action,theme:isDark.value?'dark':'light',language:'zh-CN',
    callback:value=>{token.value=value;error.value='';},
    'expired-callback':()=>{token.value='';},
    'error-callback':()=>{token.value='';error.value='验证暂时失败，请重试';},
    'timeout-callback':()=>{token.value='';error.value='验证已超时，请重试';},
  });}catch{token.value='';error.value='验证暂时失败，请重试';}
}
onMounted(reset);
watch([()=>openSettings.value.cfTurnstileSiteKey,isDark,()=>props.action],reset,{flush:'post'});
onBeforeUnmount(()=>{disposed=true;sequence++;if(widget!==undefined&&window.turnstile)window.turnstile.remove(widget);});
defineExpose({reset});
</script>
<template><div v-if="openSettings.cfTurnstileSiteKey" class="turnstile-verification"><div ref="container"></div><p v-if="error" role="alert">{{error}}</p><button type="button" class="text-button" @click="reset">刷新验证</button></div></template>
<style scoped>.turnstile-verification{margin:12px 0;min-height:65px}.turnstile-verification p{font-size:13px;color:#b3261e}</style>
