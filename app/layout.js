export const metadata = {
  title: 'MDSG OS',
  description: 'Manufacturer Direct Sales Group — Operations System',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  )
}
