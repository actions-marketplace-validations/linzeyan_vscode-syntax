<?xml version="1.0" encoding="UTF-8"?>
<!-- XSLT is a second grammar inside the built-in xml extension, bound to its
     own language id. Nothing in sample.xml reaches it: .xsl and .xslt are the
     only way in. -->
<xsl:stylesheet version="2.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    exclude-result-prefixes="xs">

  <xsl:output method="html" indent="yes" encoding="UTF-8"/>
  <xsl:param name="title" as="xs:string" select="'Report'"/>

  <xsl:template match="/">
    <html>
      <head><title><xsl:value-of select="$title"/></title></head>
      <body>
        <xsl:apply-templates select="report/finding">
          <xsl:sort select="@severity" order="descending"/>
        </xsl:apply-templates>
      </body>
    </html>
  </xsl:template>

  <xsl:template match="finding">
    <xsl:variable name="class" select="concat('sev-', @severity)"/>
    <p class="{$class}">
      <xsl:choose>
        <xsl:when test="@severity = 'error'">
          <strong><xsl:value-of select="normalize-space(text())"/></strong>
        </xsl:when>
        <xsl:otherwise>
          <xsl:value-of select="."/>
          <xsl:text> (</xsl:text>
          <xsl:number level="any" format="1"/>
          <xsl:text>)</xsl:text>
        </xsl:otherwise>
      </xsl:choose>
    </p>
  </xsl:template>

</xsl:stylesheet>
