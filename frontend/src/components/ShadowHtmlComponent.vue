<script setup>
import SafeMail from './SafeMail.vue';
defineProps({ htmlContent: { type: String, default: '' } });
</script>
<template><SafeMail :html="htmlContent" /></template>
