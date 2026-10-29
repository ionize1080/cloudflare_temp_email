<script setup>
defineProps({ name: String, size: { default: 20 } });
const paths = {
 mail: 'M3 5h18v14H3z M3 6l9 7 9-7', menu: 'M4 6h16M4 12h16M4 18h16',
 search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
 edit: 'M4 20l4-1L20 7l-4-4L4 15v5z M14 5l4 4', inbox: 'M4 4h16l2 12v4H2v-4L4 4z M2 15h6l2 3h4l2-3h6',
 send: 'M22 2L9 15 M22 2l-8 20-5-7-7-5 20-8z', star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3z',
 draft: 'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8M8 16h6', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z',
 refresh: 'M20 7v5h-5 M4 17v-5h5 M5 7a8 8 0 0 1 13-2l2 3 M4 16l2 3a8 8 0 0 0 13-2',
 back: 'M19 12H5m6-6-6 6 6 6', next: 'M9 5l7 7-7 7', prev: 'M15 5l-7 7 7 7', close: 'M6 6l12 12M6 18 18 6',
 trash: 'M3 6h18M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7m4-7v7',
 shield: 'M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4z M8 12l3 3 5-6',
 check: 'M5 12l4 4L19 6', logout: 'M9 3H4v18h5M9 12h13m-5-5 5 5-5 5',
 reply: 'M9 5l-7 7 7 7v-5c6 0 10 2 13 6-1-9-6-12-13-12V5z',
 download: 'M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5', link: 'M10 14l4-4 M8 16l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0 M16 8l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0',
 sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2',
 attach: 'M9 16l8-8a3 3 0 0 0-4-4L4 13a5 5 0 0 0 7 7L21 10', expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'
};
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.mail" /></svg></template>
