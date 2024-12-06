import type { AppProps } from 'next/app'
import '../styles/globals.css'  // Tailwind CSS
import '../public/travel-rizz.css'  // Custom styles

export default function App({ Component, pageProps }: AppProps) {
  return (
      <Component {...pageProps} />
  )
}