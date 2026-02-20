// lighthouserc.js
module.exports = {
ci: {
    collect: {
    numberOfRuns: 3,
    settings: {
        extraHeaders: {
        // Vercel Deployment Protection bypass for automation
        "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        "x-vercel-set-bypass-cookie": "true",
        },
    },
    },
    upload: {
    // Write reports locally; we’ll upload as GH artifact
    target: "filesystem",
    outputDir: "./lhci_reports",
    },
    assert: {
    assertions: {
        "categories:performance": ["error", { minScore: 0.8 }],
    },
    },
},
};