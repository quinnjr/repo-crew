import { mount } from 'svelte'
import '@fontsource-variable/martian-mono'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fortawesome/fontawesome-free/css/all.min.css'
import './app.css'
import App from './App.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('#app mount point missing from index.html')

export default mount(App, { target })
