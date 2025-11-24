import sys, json
print('PYTHON_EXECUTABLE:', sys.executable)

# Try to show pip info for the package
try:
    import pkgutil, pkg_resources
    try:
        import subprocess, shlex
        p = subprocess.run([sys.executable, '-m', 'pip', 'show', 'google-generative-ai'], capture_output=True, text=True)
        print('\nPIP_SHOW_OUTPUT:')
        print(p.stdout.strip() or '(no output)')
    except Exception as e:
        print('Could not run pip show:', e)
except Exception as e:
    print('pkg utilities not available:', e)

# Inspect the installed module
try:
    import google.generativeai as genai
    names = sorted([n for n in dir(genai) if not n.startswith('_')])
    print('\nGENAI_DIR:')
    print(json.dumps(names, indent=2))
    try:
        import google.generativeai.types as gen_types
        tnames = sorted([n for n in dir(gen_types) if not n.startswith('_')])
        print('\nGENAI_TYPES_DIR:')
        print(json.dumps(tnames, indent=2))
    except Exception as e:
        print('\nCould not import google.generativeai.types:', e)
except Exception as e:
    print('\nImportError for google.generativeai:', e)

# Also try to print version if present
try:
    print('\nGENAI_VERSION:', getattr(genai, '__version__', None))
except Exception:
    pass

print('\nDIAG_COMPLETE')
