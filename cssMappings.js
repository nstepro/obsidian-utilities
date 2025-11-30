// CSS key mappings: maps frontmatter keys to CSS rules
// Each mapping is a function that takes a value and returns a CSS rule string

const cssMappings = {
    // Image styles
    imageMaxWidth: (value) => `.markdown-holder img { max-width: ${value}; }`,
    imageMaxHeight: (value) => `.markdown-holder img { max-height: ${value}; }`,
    imageRotate: (value) => `.markdown-holder img { transform: rotate(${value}); }`,
    imageDropShadow: (value) => `.markdown-holder img { filter: drop-shadow(${value}); }`,
    imageBoxShadow: (value) => `.markdown-holder img { box-shadow: ${value}; }`,
    imageBorder: (value) => `.markdown-holder img { border: ${value}; }`,
    imageBorderRadius: (value) => `.markdown-holder img { border-radius: ${value}; }`,
    imageMargin: (value) => `.markdown-holder img { margin: ${value}; }`,
    imageAlign: (value) => `.markdown-holder p:has(> img:first-child) { text-align: ${value}; }`,
    
    // Header styles
    headerFontFamily: (value) => `.markdown-holder h1, .markdown-holder h2, .markdown-holder h3, .markdown-holder h4, .markdown-holder h5, .markdown-holder h6 { font-family: ${value}; }`,
    headerFontSize: (value) => `.markdown-holder h1, .markdown-holder h2, .markdown-holder h3, .markdown-holder h4, .markdown-holder h5, .markdown-holder h6 { font-size: ${value}; }`,
    headerColor: (value) => `.markdown-holder h1, .markdown-holder h2, .markdown-holder h3, .markdown-holder h4, .markdown-holder h5, .markdown-holder h6 { color: ${value}; }`,
    
        // Specific header level styles
        h1FontFamily: (value) => `.markdown-holder h1 { font-family: ${value}; }`,
        h1FontSize: (value) => `.markdown-holder h1 { font-size: ${value}; }`,
        h1Color: (value) => `.markdown-holder h1 { color: ${value}; }`,
        h1Margin: (value) => `.markdown-holder h1 { margin: ${value}; }`,
        h2FontFamily: (value) => `.markdown-holder h2 { font-family: ${value}; }`,
        h2FontSize: (value) => `.markdown-holder h2 { font-size: ${value}; }`,
        h2Color: (value) => `.markdown-holder h2 { color: ${value}; }`,
        h2Margin: (value) => `.markdown-holder h2 { margin: ${value}; }`,
        h3FontFamily: (value) => `.markdown-holder h3 { font-family: ${value}; }`,
        h3FontSize: (value) => `.markdown-holder h3 { font-size: ${value}; }`,
        h3Color: (value) => `.markdown-holder h3 { color: ${value}; }`,
        h3Margin: (value) => `.markdown-holder h3 { margin: ${value}; }`,
        h4FontFamily: (value) => `.markdown-holder h4 { font-family: ${value}; }`,
        h4FontSize: (value) => `.markdown-holder h4 { font-size: ${value}; }`,
        h4Color: (value) => `.markdown-holder h4 { color: ${value}; }`,
        h4Margin: (value) => `.markdown-holder h4 { margin: ${value}; }`,
        h5FontFamily: (value) => `.markdown-holder h5 { font-family: ${value}; }`,
        h5FontSize: (value) => `.markdown-holder h5 { font-size: ${value}; }`,
        h5Color: (value) => `.markdown-holder h5 { color: ${value}; }`,
        h5Margin: (value) => `.markdown-holder h5 { margin: ${value}; }`,
        h6FontFamily: (value) => `.markdown-holder h6 { font-family: ${value}; }`,
        h6FontSize: (value) => `.markdown-holder h6 { font-size: ${value}; }`,
        h6Color: (value) => `.markdown-holder h6 { color: ${value}; }`,
        h6Margin: (value) => `.markdown-holder h6 { margin: ${value}; }`,
    
    // Body/paragraph styles
    bodyFontFamily: (value) => `.markdown-holder p, .markdown-holder li { font-family: ${value}; }`,
    bodyFontSize: (value) => `.markdown-holder p, .markdown-holder li, .markdown-holder ul, .markdown-holder ol, .markdown-holder table, .markdown-holder th, .markdown-holder td { font-size: ${value}; }`,
    bodyColor: (value) => `.markdown-holder p, .markdown-holder li { color: ${value}; }`,
    baseFontSize: (value) => `.markdown-holder p, .markdown-holder li, .markdown-holder ul, .markdown-holder ol, .markdown-holder table, .markdown-holder th, .markdown-holder td { font-size: ${value}; }`,
};

module.exports = cssMappings;

