# Archive Manager — UXP extension
XPI := archive-manager.xpi
SRC := install.rdf bootstrap.js chrome.manifest chrome modules

.PHONY: all test fixtures xpi clean

all: xpi

test:
	node tests/run_tests.js

fixtures:
	python3 tests/gen_fixtures.py

xpi:
	rm -f $(XPI)
	zip -r $(XPI) $(SRC) -x '*/.DS_Store'
	@echo "Built $(XPI) — install via about:addons -> gear -> Install Add-on From File"

clean:
	rm -f $(XPI)
